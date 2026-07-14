export type RuleDecision = "allow" | "block" | "review";

export type RuleScope = "command" | "segment";

export type RuleOrigin = "user" | "builtin";

export type EvaluationDecision = RuleDecision | "review";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type UserAuthorization = "unknown" | "low" | "medium" | "high";

export type RuleCategory = {
  readonly id: string;
  readonly score: number;
};

export type CommandRule = {
  readonly label: string;
  readonly match: string;
  readonly decision: RuleDecision;
  readonly scope: RuleScope;
  readonly priority: number;
  readonly origin: RuleOrigin;
  readonly regex: RegExp;
  readonly reason?: string;
};

export type ReviewConfig = {
  readonly baseURL: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxScriptBytes: number;
  readonly maxToolCalls: number;
  readonly maxRetries: number;
  readonly contextMessages: number;
  readonly prompt: string;
};

export type RiskToolConfig = {
  readonly enabled: boolean;
  readonly path?: string;
  readonly timeoutMs: number;
  readonly failOpen: boolean;
};

export type RuntimePlatform = {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly libc?: "glibc" | "musl";
};

export type TirithReleaseAsset = {
  readonly name: string;
  readonly downloadUrl: string;
};

export type TirithRelease = {
  readonly tagName: string;
  readonly assets: readonly TirithReleaseAsset[];
};

export type TirithDownloadClient = {
  readonly listReleases: () => Promise<readonly TirithRelease[]>;
  readonly download: (url: string, maxBytes?: number) => Promise<Buffer>;
};

export type ApprovalPolicy = {
  readonly review: ReviewConfig;
  readonly riskTool: RiskToolConfig;
  readonly rules: readonly CommandRule[];
};

export type ResolvedPolicy = ApprovalPolicy;

export type ScriptEvidence = {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly bytesRead: number;
  readonly error?: string;
};

export type CommandContext = {
  readonly sessionID: string;
  readonly tool: string;
  readonly command: string;
  readonly cwd: string;
  readonly args: unknown;
  readonly scriptEvidence: readonly ScriptEvidence[];
};

export type ShellSegment = {
  readonly source: string;
  readonly normalizedSource: string;
  readonly commandName: string;
  readonly arguments: readonly string[];
  readonly rawArguments: readonly string[];
  readonly environment: readonly ShellAssignment[];
  readonly redirections: readonly ShellRedirection[];
  readonly startByte: number;
  readonly endByte: number;
  readonly nested: boolean;
  readonly stdinFromPipe: boolean;
};

export type ShellAssignment = {
  readonly name: string;
  readonly value: string;
  readonly raw: string;
};

export type ShellRedirection = {
  readonly operator: string;
  readonly target: {
    readonly raw: string;
    readonly value: string;
  };
};

export type ShellIssueKind = "syntax" | "dynamic" | "unsupported" | "limit";

export type ShellIssue = {
  readonly kind: ShellIssueKind;
  readonly reason: string;
};

export type ShellAnalysis = {
  readonly source: string;
  readonly segments: readonly ShellSegment[];
  readonly redirections: readonly ShellRedirection[];
  readonly issues: readonly ShellIssue[];
  readonly nestedAnalyses: readonly ShellAnalysis[];
};

export type MatchedRule = CommandRule & {
  readonly index: number;
  readonly segmentSource?: string;
  readonly startByte?: number;
  readonly endByte?: number;
};

export type RuleEvaluation = {
  readonly decision: EvaluationDecision;
  readonly matchedRules: readonly MatchedRule[];
  readonly categories: readonly RuleCategory[];
  readonly reasons: readonly string[];
};

export type ReviewResponse = {
  readonly outcome: "allow" | "deny";
  readonly riskLevel: RiskLevel;
  readonly userAuthorization: UserAuthorization;
  readonly categories: readonly RuleCategory[];
  readonly reasons: readonly string[];
};

export type ApprovalVerdict = {
  readonly decision: "allow" | "block";
  readonly source: "rule" | "review" | "risk_tool" | "fail_closed";
  readonly riskLevel: RiskLevel;
  readonly userAuthorization: UserAuthorization;
  readonly categories: readonly RuleCategory[];
  readonly reasons: readonly string[];
  readonly matchedRuleLabels: readonly string[];
};
