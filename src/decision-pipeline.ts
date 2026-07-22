import { evaluationWithTirithScan, scanWithTirith, verdictFromTirithScan } from "./risk-tool";
import { evaluateRulesFromAnalysis } from "./rules";
import { fetchSessionContextWithAdapter } from "./session-context";
import type { ApprovalVerdict, CommandContext, ResolvedPolicy, RuleEvaluation, ShellAnalysis } from "./types";
import { verdictFromReview, verdictFromRules } from "./verdict";
import { createMonotonicDeadline, runBoundedCall } from "./bounded-race";
import { emptyTranscriptSnapshot } from "./transcript-types";
import {
  failClosedOpenCodeReview,
  reviewWithOpenCode,
  type OpenCodeReviewerRuntime,
} from "./opencode-reviewer";
import { canonicalRootSpelling } from "./anchored-fs";
import { createCommandEffect } from "./command-effect";
import type { ConfirmationService } from "./confirmation-service";
import type { ReviewAuthorizationProof } from "./review-request";
import type { ReviewerTranscript } from "./transcript-types";

export const TRANSCRIPT_CALL_TIMEOUT_MS = 2_000;

type DecisionPipelineInput = {
  readonly policy: ResolvedPolicy;
  readonly context: CommandContext;
  readonly reviewerRuntime: OpenCodeReviewerRuntime | undefined;
  readonly analysis: ShellAnalysis;
  readonly forceReview: boolean;
  readonly confirmationService?: ConfirmationService;
};

const terminalRuleVerdict = (evaluation: RuleEvaluation): ApprovalVerdict | undefined => {
  if (evaluation.matchedRules.length === 0) return undefined;
  return verdictFromRules(evaluation);
};

export const resolveCommandVerdict = async ({
  policy,
  context,
  reviewerRuntime,
  analysis,
  forceReview,
  confirmationService,
}: DecisionPipelineInput): Promise<ApprovalVerdict> => {
  if (reviewerRuntime) {
    const canonicalContext = canonicalRootSpelling(context.cwd);
    const canonicalReviewerDirectory = canonicalRootSpelling(reviewerRuntime.directory);
    if (
      !canonicalContext.ok ||
      canonicalContext.value.absolute !== context.cwd ||
      !canonicalReviewerDirectory.ok ||
      canonicalReviewerDirectory.value.absolute !== reviewerRuntime.directory
    ) {
      return verdictFromReview(failClosedOpenCodeReview("directory_mismatch"), {
        decision: "review",
        matchedRules: [],
        categories: [],
        reasons: [],
      });
    }
  }
  const effect = createCommandEffect({ context, analysis });
  if (!effect.ok) {
    return verdictFromReview(failClosedOpenCodeReview("invalid_effect"), {
      decision: "review",
      matchedRules: [],
      categories: [],
      reasons: [],
    });
  }
  const deadline = createMonotonicDeadline(policy.review.timeoutMs);
  let authorizationProof: ReviewAuthorizationProof | undefined;
  let confirmedTranscript: ReviewerTranscript | undefined;
  if (confirmationService) {
    const confirmation = await confirmationService.check({
      effect,
      deadline,
    });
    switch (confirmation.kind) {
      case "none":
        break;
      case "confirmed":
        authorizationProof = confirmation.proof;
        confirmedTranscript = confirmation.transcript;
        break;
      case "awaiting":
        return verdictFromReview(failClosedOpenCodeReview("awaiting_explicit_confirmation"), {
          decision: "review", matchedRules: [], categories: [], reasons: [],
        });
      case "unavailable":
      case "rejected":
        return verdictFromReview(failClosedOpenCodeReview(`authorization_${confirmation.code}`), {
          decision: "review", matchedRules: [], categories: [], reasons: [],
        });
      default:
        break;
    }
  }
  const forcedReview = forceReview || authorizationProof !== undefined;
  const userRules = policy.rules.filter((rule) => rule.origin === "user");
  const builtinRules = policy.rules.filter((rule) => rule.origin === "builtin");
  const userEvaluation = evaluateRulesFromAnalysis(userRules, context.command, analysis);
  const userVerdict = terminalRuleVerdict(userEvaluation);
  if (userVerdict && (userVerdict.decision === "block" || !forcedReview)) return userVerdict;

  let evaluation: RuleEvaluation = forcedReview
    ? {
        decision: "review",
        matchedRules: userEvaluation.matchedRules,
        categories: [
          ...userEvaluation.categories,
          { id: forceReview
            ? "security.config_self_protection_ambiguous_mutation"
            : "security.explicit_authorization_confirmed", score: 0.8 },
        ],
        reasons: [...userEvaluation.reasons, forceReview
          ? "approval configuration mutation cannot be ruled out"
          : "explicit authorization was confirmed for this command effect"],
      }
    : userEvaluation;
  if (!forcedReview && userEvaluation.matchedRules.length === 0 && userEvaluation.reasons.length === 0) {
    const builtinEvaluation = evaluateRulesFromAnalysis(builtinRules, context.command, analysis);
    const builtinVerdict = terminalRuleVerdict(builtinEvaluation);
    if (builtinVerdict) return builtinVerdict;
    evaluation = builtinEvaluation;
  }

  const tirithScan = await scanWithTirith(policy, context);
  const tirithVerdict = verdictFromTirithScan(tirithScan);
  if (tirithVerdict) return tirithVerdict;

  const reviewEvaluation = evaluationWithTirithScan(evaluation, tirithScan);
  const transcriptCall = confirmedTranscript === undefined ? await runBoundedCall({
      deadline,
      timeoutMs: TRANSCRIPT_CALL_TIMEOUT_MS,
      operation: (signal) => fetchSessionContextWithAdapter({
        adapter: reviewerRuntime?.adapter,
        parentSessionID: context.sessionID,
        canonicalDirectory: reviewerRuntime?.directory ?? context.cwd,
        limit: policy.review.contextMessages,
        signal,
      }),
    }) : undefined;
  const transcript = confirmedTranscript ?? (transcriptCall?.ok
    ? transcriptCall.value.reviewer
    : emptyTranscriptSnapshot({
        status: "unavailable",
        reason: transcriptCall?.code === "rejected" ? "sdk_error" : "timeout",
      }).reviewer);
  const reviewerTranscript = confirmationService
    ? confirmationService.redact(context.sessionID, transcript)
    : transcript;
  const review = reviewerRuntime
    ? await reviewWithOpenCode(reviewerRuntime, {
        parentSessionID: context.sessionID,
        deadline,
        cleanupEnabled: policy.review.cleanupSession,
        request: {
          context,
          shellAnalysis: analysis,
          evaluation: reviewEvaluation,
          tirith: tirithScan,
          transcript: reviewerTranscript,
          ...(authorizationProof === undefined ? {} : { authorizationProof }),
        },
      })
    : failClosedOpenCodeReview("client_unavailable");
  if (review.outcome !== "needs_confirmation") return verdictFromReview(review, reviewEvaluation);
  if (authorizationProof !== undefined || !confirmationService) {
    return verdictFromReview(failClosedOpenCodeReview("confirmation_not_accepted"), reviewEvaluation);
  }
  const issued = await confirmationService.issue({ effect, review, tool: context.tool, deadline });
  if (issued.kind === "error") throw issued.error;
  return verdictFromReview(failClosedOpenCodeReview(issued.code), reviewEvaluation);
};
