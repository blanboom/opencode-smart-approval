export type RuleDecision = "allow" | "block" | "review";

export type RuleScope = "command" | "segment";

export type RuleOrigin = "user" | "builtin";

export type EvaluationDecision = RuleDecision | "review";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type UserAuthorization = "unknown" | "low" | "medium" | "high";

export type UserFacingReasonSource = "rule" | "tirith" | "path" | "policy" | "provider" | "parser" | "reviewer" | "lifecycle";

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
  readonly model?: string;
  readonly timeoutMs: number;
  readonly contextMessages: number;
  readonly prompt?: string;
  readonly cleanupSession: boolean;
};

export type TirithConfig = {
  readonly enabled: boolean;
  readonly path?: string;
  readonly timeoutMs: number;
  readonly failOpen: boolean;
};

export type SelfProtectionConfig = {
  readonly enabled: boolean;
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
  readonly tirith: TirithConfig;
  readonly selfProtection: SelfProtectionConfig;
  readonly rules: readonly CommandRule[];
};

export type ResolvedPolicy = ApprovalPolicy;

export type CommandContext = {
  readonly sessionID: string;
  readonly tool: string;
  readonly command: string;
  readonly cwd: string;
  readonly args: unknown;
};

export type ShellSegment = {
  readonly source: string;
  readonly normalizedSource: string;
  readonly commandName: string;
  readonly originalExecutable: ShellWord;
  readonly effectiveExecutable: ShellWord;
  readonly targetKind: ExecutionTargetKind;
  readonly executionCwd: string;
  readonly executionCwdKnown: boolean;
  readonly arguments: readonly string[];
  readonly rawArguments: readonly string[];
  readonly argumentWords: readonly ShellWord[];
  readonly environment: readonly ShellAssignment[];
  readonly assignments: readonly ExecutionAssignment[];
  readonly wrapperChain: readonly ShellWrapper[];
  readonly terminalAllowEligible: boolean;
  readonly redirections: readonly ShellRedirection[];
  readonly startByte: number;
  readonly endByte: number;
  readonly connector: ShellConnector;
  readonly topLevel: boolean;
  readonly subshellDepth: number;
  readonly nested: boolean;
  readonly stdinFromPipe: boolean;
};

export type ShellWord = {
  readonly raw: string;
  readonly value: string;
  readonly expansionFree: boolean;
};

export type ExecutionAssignment = ShellAssignment & {
  readonly source: "shell" | "env";
};

export type ExecutionTargetKind = "external" | "builtin" | "applet";

export type ShellWrapper = {
  readonly executable: ShellWord;
  readonly arguments: readonly ShellWord[];
  readonly executionCwd: string;
};

export type ShellConnector = "start" | "sequence" | "and" | "or" | "pipe";

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

export type ShellIssueKind = "syntax" | "dynamic" | "unsupported" | "identity" | "limit";

export type ShellIssue = {
  readonly kind: ShellIssueKind;
  readonly reason: string;
  readonly redirectionDirection?: "input" | "output";
};

export type ShellAnalysis = {
  readonly source: string;
  readonly segments: readonly ShellSegment[];
  readonly redirections: readonly ShellRedirection[];
  readonly staticFileReferences: readonly StaticFileReference[];
  readonly issues: readonly ShellIssue[];
  readonly nestedAnalyses: readonly ShellAnalysis[];
};

export type StaticFileReference = {
  readonly kind: "executable" | "shell_script" | "source" | "input_redirect";
  readonly raw: string;
  readonly value: string;
  readonly topLevelSegment: number;
  readonly cwd: string;
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

type ReviewResponseEvidence = {
  readonly riskLevel: RiskLevel;
  readonly userAuthorization: UserAuthorization;
  readonly categories: readonly RuleCategory[];
  readonly reasons: readonly string[];
};

export type ReviewConfirmation = {
  readonly action: string;
  readonly data: string;
  readonly destination: string;
  readonly risk: string;
};

export type ReviewResponse = ReviewResponseEvidence & (
  | { readonly outcome: "allow" | "deny" }
  | { readonly outcome: "needs_confirmation"; readonly confirmation: ReviewConfirmation }
);

export type ApprovalVerdict = {
  readonly decision: "allow" | "block";
  readonly source: "rule" | "review" | "risk_tool" | "fail_closed";
  readonly reasonSource: UserFacingReasonSource;
  readonly riskLevel: RiskLevel;
  readonly userAuthorization: UserAuthorization;
  readonly categories: readonly RuleCategory[];
  readonly reasons: readonly string[];
  readonly matchedRuleLabels: readonly string[];
};
