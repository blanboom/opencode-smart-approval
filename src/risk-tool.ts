import { parseTirithMetadata, runTirithCompatibleTool } from "./risk-tool-runner";
import type { TirithFinding, TirithMetadata, TirithProcessRun } from "./risk-tool-runner";
import type {
  ApprovalVerdict,
  CommandContext,
  ResolvedPolicy,
  RiskLevel,
  RuleCategory,
  RuleEvaluation,
} from "./types";

export type TirithScan =
  | {
      readonly action: "allow";
      readonly freshness?: "configured" | "current" | "stale_verified";
      readonly categories?: readonly RuleCategory[];
      readonly reasons?: readonly string[];
    }
  | {
      readonly action: "warn";
      readonly riskLevel: RiskLevel;
      readonly categories: readonly RuleCategory[];
      readonly reasons: readonly string[];
      readonly freshness: "configured" | "current" | "stale_verified";
    }
  | {
      readonly action: "block";
      readonly source: "risk_tool" | "fail_closed";
      readonly riskLevel: RiskLevel;
      readonly categories: readonly RuleCategory[];
      readonly reasons: readonly string[];
      readonly freshness?: "configured" | "current" | "stale_verified";
    };

class TirithInvariantError extends Error {
  readonly name = "TirithInvariantError";
  constructor() {
    super("unreachable Tirith scan variant");
  }
}

const assertNever = (value: never): never => {
  void value;
  throw new TirithInvariantError();
};

const findingIdentifier = (finding: TirithFinding): string => {
  const raw = finding.ruleId ?? finding.title ?? "unknown";
  const normalized = raw
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9_.:-]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "");
  return normalized.length > 0 ? normalized.slice(0, 80) : "unknown";
};

const scoreForSeverity = (severity: string | undefined): number => {
  switch (severity?.trim().toLowerCase()) {
    case "critical":
      return 0.95;
    case "high":
      return 0.85;
    case "medium":
      return 0.65;
    case "low":
      return 0.35;
    default:
      return 0.7;
  }
};

const riskLevelForScan = (action: "warn" | "block", findings: readonly TirithFinding[]): RiskLevel => {
  if (action === "warn") return "medium";
  return findings.some((finding) => finding.severity?.trim().toLowerCase() === "critical") ? "critical" : "high";
};

const categoriesForFindings = (findings: readonly TirithFinding[], fallback: string): readonly RuleCategory[] => {
  if (findings.length === 0) return [{ id: `risk_tool.${fallback}`, score: 0.8 }];
  return findings.map((finding) => ({
    id: `risk_tool.${findingIdentifier(finding)}`,
    score: scoreForSeverity(finding.severity),
  }));
};

const formatFinding = (finding: TirithFinding): string => {
  const label = finding.title ?? finding.ruleId ?? "security finding";
  const severity = finding.severity ? `[${finding.severity}] ` : "";
  return finding.description ? `${severity}${label}: ${finding.description}` : `${severity}${label}`;
};

const reasonsForScan = (
  metadata: TirithMetadata,
  fallback: string,
  maxFindings: number = 3,
): readonly string[] => {
  const summary = metadata.summary || fallback;
  const findings = metadata.findings.slice(0, maxFindings).map(formatFinding);
  return [summary, ...findings].filter((reason) => reason.trim().length > 0);
};

const failureScan = (policy: ResolvedPolicy, reason: string): TirithScan => {
  if (policy.tirith.failOpen) return { action: "allow" };
  return {
    action: "block",
    source: "fail_closed",
    riskLevel: "high",
    categories: [{ id: "security.risk_tool_unavailable", score: 1 }],
    reasons: [reason],
  };
};

const staleEvidence = (freshness: "configured" | "current" | "stale_verified"): {
  readonly categories: readonly RuleCategory[];
  readonly reasons: readonly string[];
} => freshness === "stale_verified"
  ? {
      categories: [{ id: "risk_tool.stale_verified", score: 0.5 }],
      reasons: ["Tirith cached binary is stale but locally hash verified"],
    }
  : { categories: [], reasons: [] };

const scanFromExit = (
  exitCode: number | null,
  metadata: TirithMetadata,
  freshness: "configured" | "current" | "stale_verified",
): TirithScan => {
  const evidence = staleEvidence(freshness);
  if (exitCode === 0) return { action: "allow", freshness, ...evidence };
  if (exitCode === 1) {
    return {
      action: "block",
      source: "risk_tool",
      riskLevel: riskLevelForScan("block", metadata.findings),
      categories: [...categoriesForFindings(metadata.findings, "tirith_block"), ...evidence.categories],
      reasons: [...reasonsForScan(metadata, "Tirith blocked this command"), ...evidence.reasons],
      freshness,
    };
  }
  if (exitCode === 2) {
    return {
      action: "warn",
      riskLevel: riskLevelForScan("warn", metadata.findings),
      categories: [...categoriesForFindings(metadata.findings, "tirith_warn"), ...evidence.categories],
      reasons: [...reasonsForScan(metadata, "Tirith warned about this command"), ...evidence.reasons],
      freshness,
    };
  }
  return {
    action: "block",
    source: "fail_closed",
    riskLevel: "high",
    categories: [{ id: "security.risk_tool_unavailable", score: 1 }],
    reasons: ["risk_tool_failure:unexpected_exit"],
    freshness,
  };
};

export const scanFromTirithResult = (
  policy: ResolvedPolicy,
  result: TirithProcessRun,
): TirithScan => {
  switch (result.kind) {
    case "skipped":
      return failureScan(policy, "risk_tool_failure:unavailable");
    case "timeout":
      return failureScan(policy, "risk_tool_failure:timeout");
    case "error":
      return failureScan(policy, "risk_tool_failure:start");
    case "exit":
      if (result.exitCode !== 0 && result.exitCode !== 1 && result.exitCode !== 2) {
        return failureScan(policy, "risk_tool_failure:unexpected_exit");
      }
      return scanFromExit(result.exitCode, parseTirithMetadata(result.stdout), result.freshness);
  }
};

export const scanWithTirith = async (policy: ResolvedPolicy, context: CommandContext): Promise<TirithScan> => {
  if (!policy.tirith.enabled) return { action: "allow" };
  return scanFromTirithResult(policy, await runTirithCompatibleTool(policy, context));
};

export const evaluationWithTirithScan = (
  evaluation: RuleEvaluation,
  scan: TirithScan,
): RuleEvaluation => {
  switch (scan.action) {
    case "block":
      return evaluation;
    case "allow":
    case "warn": {
      const scanCategories = scan.categories ?? [];
      const scanReasons = scan.reasons ?? [];
      if (scanCategories.length === 0 && scanReasons.length === 0) return evaluation;
      return {
        decision: "review",
        matchedRules: evaluation.matchedRules,
        categories: [...evaluation.categories, ...scanCategories],
        reasons: [...evaluation.reasons, ...scanReasons],
      };
    }
    default:
      return assertNever(scan);
  }
};

export const verdictFromTirithScan = (scan: TirithScan): ApprovalVerdict | undefined => {
  switch (scan.action) {
    case "allow":
    case "warn":
      return undefined;
    case "block":
      return {
        decision: "block",
        source: scan.source,
        reasonSource: "tirith",
        riskLevel: scan.riskLevel,
        userAuthorization: "unknown",
        categories: scan.categories,
        reasons: scan.reasons,
        matchedRuleLabels: [],
      };
    default:
      return assertNever(scan);
  }
};
