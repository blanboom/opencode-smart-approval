import { analyzeShell } from "./shell-analysis";
import type {
  CommandContext,
  CommandRule,
  EvaluationDecision,
  MatchedRule,
  RuleCategory,
  RuleEvaluation,
  ShellAnalysis,
  ShellSegment,
} from "./types";

const categoryForRule = (rule: CommandRule): RuleCategory => {
  const score = rule.decision === "block" ? 1 : rule.decision === "review" ? 0.5 : 0.05;
  return { id: `policy.${rule.decision}.${rule.label}`, score };
};

const decisionPriority = (decision: EvaluationDecision): number => {
  if (decision === "block") return 3;
  if (decision === "review") return 2;
  return 1;
};

const matchRule = (rule: CommandRule, source: string, index: number, segment?: ShellSegment): MatchedRule | undefined => {
  if (!rule.regex.test(source)) return undefined;
  return {
    ...rule,
    index,
    ...(segment
      ? {
          segmentSource: segment.source,
          startByte: segment.startByte,
          endByte: segment.endByte,
        }
      : {}),
  };
};

type ResolvedMatches = {
  readonly decision: EvaluationDecision;
  readonly winners: readonly MatchedRule[];
};

const resolveMatches = (matches: readonly MatchedRule[]): ResolvedMatches => {
  if (matches.length === 0) return { decision: "review", winners: [] };
  const highestPriority = Math.max(...matches.map((rule) => rule.priority));
  const priorityWinners = matches.filter((rule) => rule.priority === highestPriority);
  const decision = priorityWinners.reduce<EvaluationDecision>((strongest, rule) =>
    decisionPriority(rule.decision) > decisionPriority(strongest) ? rule.decision : strongest,
  "allow");
  return {
    decision,
    winners: priorityWinners.filter((rule) => rule.decision === decision),
  };
};

const eligibleForSegment = (matches: readonly MatchedRule[], segment: ShellSegment): readonly MatchedRule[] => {
  const hasOutputRedirection = segment.redirections.some((redirection) => !redirection.operator.startsWith("<"));
  return matches.filter((rule) => {
    if (rule.decision === "allow" && rule.scope === "segment" && !segment.terminalAllowEligible) return false;
    return !hasOutputRedirection || rule.origin !== "builtin" || rule.decision !== "allow";
  });
};

const isExactCommandMatch = (rule: MatchedRule, command: string): boolean => {
  if (!rule.match.startsWith("^") || !rule.match.endsWith("$")) return false;
  const match = rule.regex.exec(command);
  return match?.index === 0 && match[0].length === command.length;
};

const commandMatchEligible = (rule: MatchedRule, command: string, segments: readonly ShellSegment[]): boolean => {
  if (rule.decision !== "allow") return true;
  const requiresExactMatch = segments.length !== 1 || segments.some((segment) => !segment.terminalAllowEligible);
  return !requiresExactMatch || isExactCommandMatch(rule, command);
};

const strongest = (decisions: readonly EvaluationDecision[]): EvaluationDecision => {
  return decisions.reduce<EvaluationDecision>((current, decision) =>
    decisionPriority(decision) > decisionPriority(current) ? decision : current,
  "allow");
};

const unique = <T>(values: readonly T[], key: (value: T) => string): readonly T[] => {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identity = key(value);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
};

export const evaluateRulesFromAnalysis = (
  rules: readonly CommandRule[],
  command: string,
  analysis: ShellAnalysis,
): RuleEvaluation => {
  const commandMatches = rules.flatMap((rule, index) => {
    if (rule.scope !== "command") return [];
    const matched = matchRule(rule, command, index);
    return matched ? [matched] : [];
  });
  const eligibleCommandMatches = commandMatches.filter((rule) => commandMatchEligible(rule, command, analysis.segments));
  const hasExactCommandAllow = commandMatches.some((rule) => rule.decision === "allow" && isExactCommandMatch(rule, command));
  const nodeResults: ResolvedMatches[] = [];

  if (analysis.segments.length === 1) {
    const segment = analysis.segments[0];
    if (segment) {
      const segmentMatches = rules.flatMap((rule, index) => {
        if (rule.scope !== "segment") return [];
        const matched = matchRule(rule, segment.normalizedSource, index, segment);
        return matched ? [matched] : [];
      });
      nodeResults.push(resolveMatches(eligibleForSegment([...eligibleCommandMatches, ...segmentMatches], segment)));
    }
  } else {
    const commandEscalations = eligibleCommandMatches.filter((rule) => rule.decision !== "allow");
    const exactCommandAllows = eligibleCommandMatches.filter((rule) => rule.decision === "allow");
    if (commandEscalations.length > 0) nodeResults.push(resolveMatches(commandEscalations));
    for (const segment of analysis.segments) {
      const matches = rules.flatMap((rule, index) => {
        if (rule.scope !== "segment") return [];
        const matched = matchRule(rule, segment.normalizedSource, index, segment);
        return matched ? [matched] : [];
      });
      nodeResults.push(resolveMatches(eligibleForSegment([...exactCommandAllows, ...matches], segment)));
    }
  }

  const applicableIssues = analysis.issues.filter((entry) => entry.kind !== "identity" || !hasExactCommandAllow);
  const issueReasons = applicableIssues.map((entry) => entry.reason);
  const decisions = nodeResults.map((result) => result.decision);
  if (analysis.segments.length === 0 || issueReasons.length > 0) decisions.push("review");
  const decision = strongest(decisions.length > 0 ? decisions : ["review"]);
  const matchedRules = unique(
    nodeResults.flatMap((result) => result.winners),
    (rule) => `${String(rule.index)}:${rule.startByte ?? -1}:${rule.endByte ?? -1}`,
  );
  const reasons = unique(
    [
      ...matchedRules.map((rule) => rule.reason ?? `matched ${rule.label} command approval rule`),
      ...issueReasons,
    ],
    (reason) => reason,
  );
  const categories = unique(
    [
      ...matchedRules.map(categoryForRule),
      ...(issueReasons.length > 0 ? [{ id: "policy.review.shell_analysis", score: 0.5 }] : []),
    ],
    (category) => category.id,
  );
  return { decision, matchedRules, categories, reasons };
};

export const evaluateRules = async (
  rules: readonly CommandRule[],
  context: Pick<CommandContext, "command">,
): Promise<RuleEvaluation> => {
  const analysis = await analyzeShell(context.command);
  return evaluateRulesFromAnalysis(rules, context.command, analysis);
};
