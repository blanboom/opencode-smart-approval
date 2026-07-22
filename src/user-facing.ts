import type { ApprovalVerdict, RuleCategory } from "./types";
import { isValidCategoryId } from "./category-id";
import { escapeUserFacingScalar, renderUserFacingReason } from "./user-facing-scalar";
import {
  renderConfirmationBody,
  type ConfirmationBodyResult,
  type ConfirmationChallenge,
  type ConfirmationValues,
} from "./confirmation-renderer";
export { escapeUserFacingScalar, renderUserFacingReason } from "./user-facing-scalar";
export type { EscapedUserFacingScalar, UserFacingReason } from "./user-facing-scalar";
export { renderConfirmationBody } from "./confirmation-renderer";
export type { ConfirmationBodyResult, ConfirmationChallenge, ConfirmationValues } from "./confirmation-renderer";

const MAX_TOOL_BYTES = 1_024;
const MAX_REASON_COUNT = 16;
const MAX_CATEGORY_COUNT = 32;
const MAX_AGGREGATE_REASON_BYTES = 8_192;
const MAX_BODY_BYTES = 16_384;
const BODY_TRUNCATION_MARKER = "truncated=true";

type OrdinaryErrorInput = {
  readonly kind: "ordinary";
  readonly tool: string;
  readonly verdict: ApprovalVerdict;
};

type ConfirmationErrorInput = {
  readonly kind: "confirmation";
  readonly tool: string;
  readonly verdict: ApprovalVerdict;
  readonly challenge: ConfirmationChallenge;
};

export type CommandApprovalErrorInput = OrdinaryErrorInput | ConfirmationErrorInput;

export type CommandApprovalError = Error & {
  readonly name: "CommandApprovalError";
  readonly tool: string;
  readonly verdict: ApprovalVerdict;
};

export type RenderedCommandApprovalError =
  | { readonly kind: "error"; readonly error: CommandApprovalError }
  | { readonly kind: "confirmation_failure"; readonly code: "confirmation_render_failed" };

class UserFacingInvariantError extends Error {
  readonly name = "UserFacingInvariantError";
  constructor() {
    super("unreachable user-facing render variant");
  }
}

class CommandApprovalFailure extends Error implements CommandApprovalError {
  readonly name = "CommandApprovalError";
  constructor(
    readonly tool: string,
    readonly verdict: ApprovalVerdict,
    body: string,
  ) {
    super(body);
  }
}

const authenticCommandApprovalErrors = new WeakSet<object>();

const commandApprovalFailure = (tool: string, verdict: ApprovalVerdict, body: string): CommandApprovalError => {
  const error = Object.freeze(new CommandApprovalFailure(tool, verdict, body));
  authenticCommandApprovalErrors.add(error);
  return error;
};

const assertNever = (value: never): never => {
  void value;
  throw new UserFacingInvariantError();
};

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

const validatedCategory = (category: RuleCategory): RuleCategory | undefined => {
  if (!isValidCategoryId(category.id)) return undefined;
  if (!Number.isFinite(category.score) || category.score < 0 || category.score > 1) return undefined;
  return category;
};

const escapedTool = (tool: string): string => {
  const escaped: string[] = [];
  let bytes = 0;
  for (const scalar of tool) {
    const result = escapeUserFacingScalar(scalar);
    switch (result.ok) {
      case true:
        bytes += byteLength(result.value);
        if (bytes > MAX_TOOL_BYTES) return "[tool-too-long]";
        escaped.push(result.value);
        break;
      case false:
        return "[invalid-unicode]";
      default:
        return assertNever(result);
    }
  }
  return escaped.join("");
};

const ordinaryBody = (input: OrdinaryErrorInput): { readonly body: string; readonly verdict: ApprovalVerdict; readonly tool: string } => {
  const tool = escapedTool(input.tool);
  const categories: RuleCategory[] = [];
  let dropped = false;
  for (const category of input.verdict.categories) {
    if (categories.length >= MAX_CATEGORY_COUNT) {
      dropped = true;
      break;
    }
    const validated = validatedCategory(category);
    if (validated) categories.push(validated);
    else dropped = true;
  }
  const reasons: string[] = [];
  let aggregateReasonBytes = 0;
  for (const reason of input.verdict.reasons.slice(0, MAX_REASON_COUNT)) {
    const rendered = renderUserFacingReason({ source: input.verdict.reasonSource, text: reason });
    const renderedBytes = byteLength(rendered);
    if (aggregateReasonBytes + renderedBytes > MAX_AGGREGATE_REASON_BYTES) {
      dropped = true;
      break;
    }
    reasons.push(rendered);
    aggregateReasonBytes += renderedBytes;
  }
  if (input.verdict.reasons.length > reasons.length) dropped = true;
  const lines = [
    "[CommandApproval]",
    "decision=block",
    `tool=${tool}`,
    `source=${input.verdict.source}`,
    `risk=${input.verdict.riskLevel}`,
    `authorization=${input.verdict.userAuthorization}`,
    ...categories.map((category) => `category=${category.id};score=${String(category.score)}`),
    ...reasons.map((reason) => `reason=${reason}`),
    ...(dropped ? [BODY_TRUNCATION_MARKER] : []),
  ];
  let body = lines.join("\n");
  if (byteLength(body) > MAX_BODY_BYTES) {
    const retained: string[] = [];
    for (const line of lines) {
      const candidate = [...retained, line, BODY_TRUNCATION_MARKER].join("\n");
      if (byteLength(candidate) > MAX_BODY_BYTES) break;
      retained.push(line);
    }
    if (retained.at(-1) !== BODY_TRUNCATION_MARKER) retained.push(BODY_TRUNCATION_MARKER);
    body = retained.join("\n");
  }
  return {
    body,
    tool,
    verdict: {
      ...input.verdict,
      categories,
      reasons,
      matchedRuleLabels: [],
    },
  };
};

export const renderCommandApprovalError = (input: CommandApprovalErrorInput): RenderedCommandApprovalError => {
  switch (input.kind) {
    case "ordinary": {
      const rendered = ordinaryBody(input);
      return { kind: "error", error: commandApprovalFailure(rendered.tool, rendered.verdict, rendered.body) };
    }
    case "confirmation": {
      const confirmation = renderConfirmationBody(input.challenge);
      switch (confirmation.ok) {
        case true: {
          const rendered = ordinaryBody({ kind: "ordinary", tool: input.tool, verdict: input.verdict });
          return { kind: "error", error: commandApprovalFailure(rendered.tool, rendered.verdict, confirmation.body) };
        }
        case false:
          return { kind: "confirmation_failure", code: confirmation.code };
        default:
          return assertNever(confirmation);
      }
    }
    default:
      return assertNever(input);
  }
};

export const isCommandApprovalError = (error: unknown): error is CommandApprovalError => (
  typeof error === "object" && error !== null && authenticCommandApprovalErrors.has(error)
);
