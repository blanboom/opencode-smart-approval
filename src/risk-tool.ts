import { parseRiskToolMetadata, runTirithCompatibleTool } from "./risk-tool-runner";
import type { RiskToolFinding, RiskToolMetadata, RiskToolProcessRun } from "./risk-tool-runner";
import type {
  ApprovalVerdict,
  CommandContext,
  ResolvedPolicy,
  RiskLevel,
  RuleCategory,
  RuleEvaluation,
} from "./types";

export type RiskToolScan =
  | {
      readonly action: "allow";
    }
  | {
      readonly action: "warn";
      readonly riskLevel: RiskLevel;
      readonly categories: readonly RuleCategory[];
      readonly reasons: readonly string[];
    }
  | {
      readonly action: "block";
      readonly source: "risk_tool" | "fail_closed";
      readonly riskLevel: RiskLevel;
      readonly categories: readonly RuleCategory[];
      readonly reasons: readonly string[];
    };

const findingIdentifier = (finding: RiskToolFinding): string => {
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

const riskLevelForScan = (action: "warn" | "block", findings: readonly RiskToolFinding[]): RiskLevel => {
  if (action === "warn") return "medium";
  return findings.some((finding) => finding.severity?.trim().toLowerCase() === "critical") ? "critical" : "high";
};

const categoriesForFindings = (findings: readonly RiskToolFinding[], fallback: string): readonly RuleCategory[] => {
  if (findings.length === 0) return [{ id: `risk_tool.${fallback}`, score: 0.8 }];
  return findings.map((finding) => ({
    id: `risk_tool.${findingIdentifier(finding)}`,
    score: scoreForSeverity(finding.severity),
  }));
};

const formatFinding = (finding: RiskToolFinding): string => {
  const label = finding.title ?? finding.ruleId ?? "security finding";
  const severity = finding.severity ? `[${finding.severity}] ` : "";
  return finding.description ? `${severity}${label}: ${finding.description}` : `${severity}${label}`;
};

const reasonsForScan = (
  metadata: RiskToolMetadata,
  fallback: string,
  maxFindings: number = 3,
): readonly string[] => {
  const summary = metadata.summary || fallback;
  const findings = metadata.findings.slice(0, maxFindings).map(formatFinding);
  return [summary, ...findings].filter((reason) => reason.trim().length > 0);
};

const failureScan = (policy: ResolvedPolicy, reason: string): RiskToolScan => {
  if (policy.riskTool.failOpen) return { action: "allow" };
  return {
    action: "block",
    source: "fail_closed",
    riskLevel: "high",
    categories: [{ id: "security.risk_tool_unavailable", score: 1 }],
    reasons: [reason],
  };
};

const scanFromExit = (exitCode: number | null, metadata: RiskToolMetadata): RiskToolScan => {
  if (exitCode === 0) return { action: "allow" };
  if (exitCode === 1) {
    return {
      action: "block",
      source: "risk_tool",
      riskLevel: riskLevelForScan("block", metadata.findings),
      categories: categoriesForFindings(metadata.findings, "tirith_block"),
      reasons: reasonsForScan(metadata, "risk tool blocked this command"),
    };
  }
  if (exitCode === 2) {
    return {
      action: "warn",
      riskLevel: riskLevelForScan("warn", metadata.findings),
      categories: categoriesForFindings(metadata.findings, "tirith_warn"),
      reasons: reasonsForScan(metadata, "risk tool warned about this command"),
    };
  }
  return {
    action: "block",
    source: "fail_closed",
    riskLevel: "high",
    categories: [{ id: "security.risk_tool_unavailable", score: 1 }],
    reasons: [`risk tool exited with unexpected code ${String(exitCode)}`],
  };
};

export const scanFromRiskToolResult = (
  policy: ResolvedPolicy,
  result: RiskToolProcessRun,
): RiskToolScan => {
  switch (result.kind) {
    case "skipped":
      return failureScan(policy, `risk tool unavailable: ${result.reason}`);
    case "timeout":
      return failureScan(policy, `risk tool timed out after ${String(policy.riskTool.timeoutMs)} ms`);
    case "error":
      return failureScan(policy, `risk tool failed to start: ${result.error.message}`);
    case "exit":
      if (result.exitCode !== 0 && result.exitCode !== 1 && result.exitCode !== 2) {
        return failureScan(policy, `risk tool exited with unexpected code ${String(result.exitCode)}`);
      }
      return scanFromExit(result.exitCode, parseRiskToolMetadata(result.stdout));
  }
};

export const scanWithRiskTool = async (policy: ResolvedPolicy, context: CommandContext): Promise<RiskToolScan> => {
  if (!policy.riskTool.enabled) return { action: "allow" };
  return scanFromRiskToolResult(policy, await runTirithCompatibleTool(policy, context));
};

export const evaluationWithRiskToolScan = (
  evaluation: RuleEvaluation,
  scan: RiskToolScan,
): RuleEvaluation => {
  if (scan.action !== "warn") return evaluation;
  return {
    decision: "review",
    matchedRules: evaluation.matchedRules,
    categories: [...evaluation.categories, ...scan.categories],
    reasons: [...evaluation.reasons, ...scan.reasons],
  };
};

export const verdictFromRiskToolScan = (scan: RiskToolScan): ApprovalVerdict | undefined => {
  if (scan.action !== "block") return undefined;
  return {
    decision: "block",
    source: scan.source,
    riskLevel: scan.riskLevel,
    userAuthorization: "unknown",
    categories: scan.categories,
    reasons: scan.reasons,
    matchedRuleLabels: [],
  };
};
