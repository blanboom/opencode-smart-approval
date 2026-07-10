import type { ApprovalPolicy, CommandRule, ReviewConfig, RiskToolConfig, RuleDecision } from "./types";
import { DEFAULT_REVIEWER_POLICY } from "./prompt";

type ConfigRule = {
  readonly match: string;
  readonly reason?: string;
};

type ConfigRuleEntry = string | ConfigRule;

const blockRules = [
  {
    match:
      "(\\.env\\b|(?:^|[\\s\"'])(?:~|\\$HOME|/[^\\s\"']*)/\\.(?:ssh|aws|docker)(?:/|\\b)|/\\.aws/credentials|/\\.docker/config\\.json|auth\\.json|command-approval\\.json|\\.netrc|\\.npmrc|\\.pypirc)",
    reason: "references files that commonly contain credentials or approval policy",
  },
  {
    match:
      "(?:^|[\\s\"'])\\$(?:\\{)?(?:[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY|API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN))[A-Za-z0-9_]*|KEY)(?:\\})?(?:\\b|[^A-Za-z0-9_])",
    reason: "expands an environment variable whose name looks secret-bearing",
  },
  {
    match: "^(?!git\\s).*?(?:^|[\\s/])\\.git(?:/|\\b).*",
    reason: "direct .git directory access can bypass git safety checks",
  },
  {
    match: "(?:curl|wget)\\b.*(?:\\|\\s*(?:ba|z)?sh\\b|(?:&&|;)\\s*(?:ba|z)?sh\\b)",
    reason: "downloads remote code and executes it with a shell",
  },
  {
    match: "(^|[;&|]\\s*)sudo\\b|\\|\\s*sudo\\b",
    reason: "sudo should not run unattended",
  },
  {
    match: "(?:^|[;&|]\\s*)(?:env|printenv|set)(?:\\s|$).*",
    reason: "environment dumps often expose API keys and tokens",
  },
  {
    match: "(?:^|[;&|]\\s*)security\\s+(?:find-(?:generic|internet)-password|dump-keychain)(?:\\s|$).*",
    reason: "macOS keychain reads can expose credentials",
  },
  {
    match:
      "\\brm\\s+(?=[^\\r\\n;&|]*?(?:-[A-Za-z]*[rR]|--recursive))(?=[^\\r\\n;&|]*?\\s(?:/|~|\\$HOME|/Users/[^\\s/]+)(?:\\s|/|$))[^\\r\\n;&|]*",
    reason: "recursive delete targets root, home, or a broad home subtree",
  },
  {
    match:
      "\\b(?:diskutil\\s+(?:erase|partition|zeroDisk|secureErase)|dd\\b.*\\bof=/dev/|(?:mkfs|newfs_[A-Za-z0-9_]+)\\b|rsync\\b.*\\s--delete(?:\\s|$)|chmod\\b.*\\s-R\\b.*\\s/|chown\\b.*\\s-R\\b.*\\s/)",
    reason: "disk, device, root-recursive permission, or rsync delete operations are high risk",
  },
  {
    match: "(?:^|[;&|]\\s*)git\\s+(?:reset\\s+--hard|clean\\b|checkout\\s+--|restore\\b)",
    reason: "can discard user work",
  },
  {
    match:
      "(?:^|[;&|]\\s*)git\\b.*(?:-c\\s+core\\.hooksPath=|--config(?:=|\\s+)core\\.hooksPath=|commit\\b.*(?:\\s--no-verify\\b|\\s-n(?:\\s|$))|push\\b.*\\s--no-verify\\b).*",
    reason: "bypasses git hooks and safety checks",
  },
  {
    match: "(?:^|[;&|]\\s*)git\\s+push\\b.*(?:\\s--(?:force|delete|mirror|prune)(?:[=\\s]|$)|\\s-f(?:\\s|$)|\\s:\\S+).*",
    reason: "force, delete, mirror, prune, or ref-deletion pushes can alter remote history destructively",
  },
  {
    match:
      "(?:^|[;&|]\\s*)gh\\s+(?:repo\\s+(?:delete|create|edit|rename|archive)\\b|release\\s+(?:create|delete|edit|upload)\\b|workflow\\s+(?:run|enable|disable)\\b|run\\s+(?:cancel|rerun)\\b|(?:secret|variable)\\b|auth\\s+(?:login|logout|refresh|token)\\b|(?:ssh-key|gpg-key)\\s+(?:add|delete)\\b|api\\b.*(?:--method[=\\s]+(?:POST|PUT|PATCH|DELETE)|-X[=\\s]+(?:POST|PUT|PATCH|DELETE))).*",
    reason: "GitHub admin, auth, secret, workflow, release, or write API operations need explicit user control",
  },
  {
    match: "(?:^|[;&|]\\s*)(?:openclaw\\s+run\\b|opencode\\s+run\\b|codex\\s+exec\\b|claude\\b).*",
    reason: "nested unattended coding agents can multiply tool execution",
  },
  {
    match: "(?:^|[;&|]\\s*)yes(?:\\s|$).*",
    reason: "can hang or blindly confirm prompts",
  },
] satisfies readonly ConfigRule[];

const reviewRules = [
  {
    match: "(?:^|[;&|]\\s*)git\\s+push\\b(?!.*(?:--(?:force|delete|mirror|prune)|\\s-f(?:\\s|$)|\\s:\\S+)).*",
    reason: "git push to remote needs LLM review for branch protection and force flags",
  },
  {
    match: "(?:^|[;&|]\\s*)(?:npm|pnpm|yarn)\\s+publish\\b.*",
    reason: "package publishing is a public, irreversible action",
  },
  {
    match: "(?:^|[;&|]\\s*)(?:docker|podman)\\s+(?:push|build\\b.*--push)\\b.*",
    reason: "container push to registry is a public, irreversible action",
  },
] satisfies readonly ConfigRule[];

const allowRules = [
  "^(?!.*(?:&&|\\|\\||[;&|<>`]|\\$\\(|<\\(|>\\(|[\\r\\n]))(?:pwd|which|date|uname|whoami|id|df|du|stat|sw_vers|jq|ls|head|tail|rg|wc|grep|cat|sort|file|ffprobe|echo|printf|true|false|expr|cut|nl|paste|rev|seq|tr|uniq|base64)(?:\\s|$).*",
  "^(?!.*(?:&&|\\|\\||[;&|<>`]|\\$\\(|<\\(|>\\(|[\\r\\n]))(?:node|bun|npm|pnpm|yarn|python3?|pip3?|cargo|rustc|go|swift|xcodebuild|opencode|gh|git)\\s+(?:--version|-v|-version|version|--help|-h|help)\\s*$",
  "^(?!.*(?:&&|\\|\\||[;&|<>`]|\\$\\(|<\\(|>\\(|[\\r\\n]))git\\s+(?:status|diff|log|show|branch|rev-parse|ls-files|grep|blame|fetch|describe|reflog|remote\\s+(?:-v|show)|config\\s+(?:--get|--list)|stash\\s+(?:list|show)|tag\\s+(?:--list|-l))(?:\\s|$).*",
  "^(?!.*(?:&&|\\|\\||[;&|<>`]|\\$\\(|<\\(|>\\(|[\\r\\n]))(?:(?:npm|pnpm|yarn|bun)\\s+(?:test|run\\s+(?:test|typecheck|lint|build))\\b|python3?\\s+-m\\s+pytest\\b(?!.*(?:\\s--pyargs\\b|\\s/|\\.\\.))|pytest\\b(?!.*(?:\\s--pyargs\\b|\\s/|\\.\\.))|swift\\s+(?:test|build)\\b|cargo\\s+(?:test|build|check)\\b|go\\s+test\\b).*",
  "^(?!.*(?:&&|\\|\\||[;&|<>`]|\\$\\(|<\\(|>\\(|[\\r\\n]))(?:plutil\\s+-lint|defaults\\s+read|mdls|codesign\\s+-d|otool\\s+-L|lipo\\s+-info|xcrun\\s+simctl\\s+(?:list|bootstatus|get_app_container|listapps))(?:\\s|$).*",
  "^(?!.*(?:&&|\\|\\||[;&|<>`]|\\$\\(|<\\(|>\\(|[\\r\\n]))(?:mkdir|touch|cp)(?:\\s|$).*",
] satisfies readonly string[];

const matchForEntry = (entry: ConfigRuleEntry): string => {
  return typeof entry === "string" ? entry : entry.match;
};

const reasonForEntry = (entry: ConfigRuleEntry): string | undefined => {
  return typeof entry === "string" ? undefined : entry.reason;
};

const rulesWithDecision = (decision: RuleDecision, rules: readonly ConfigRuleEntry[]): readonly CommandRule[] => {
  return rules.map((rule, index) => {
    const reason = reasonForEntry(rule);
    return {
      label: `${decision}[${String(index)}]`,
      match: matchForEntry(rule),
      decision,
      ...(reason ? { reason } : {}),
    };
  });
};

const allRules = (): readonly CommandRule[] => {
  return [
    ...rulesWithDecision("block", blockRules),
    ...rulesWithDecision("review", reviewRules),
    ...rulesWithDecision("allow", allowRules),
  ];
};

export type DefaultReviewConnection = Pick<ReviewConfig, "baseURL" | "apiKey" | "model">;

export const DEFAULT_REVIEW_CONNECTION = {
  baseURL: "",
  apiKey: "",
  model: "",
} as const satisfies DefaultReviewConnection;

export const DEFAULT_REVIEW_MAX_RETRIES = 3;

export const DEFAULT_RISK_TOOL = {
  enabled: true,
  timeoutMs: 5_000,
  failOpen: false,
} as const satisfies RiskToolConfig;

export const defaultPolicy = (connection: DefaultReviewConnection = DEFAULT_REVIEW_CONNECTION): ApprovalPolicy => ({
  review: {
    baseURL: connection.baseURL,
    apiKey: connection.apiKey,
    model: connection.model,
    timeoutMs: 45_000,
    maxScriptBytes: 20_000,
    maxToolCalls: 3,
    maxRetries: DEFAULT_REVIEW_MAX_RETRIES,
    contextMessages: 20,
    prompt: DEFAULT_REVIEWER_POLICY,
  },
  riskTool: DEFAULT_RISK_TOOL,
  rules: allRules(),
});

const defaultConfigObject = (connection: DefaultReviewConnection = DEFAULT_REVIEW_CONNECTION) => ({
  allow_local_config: false,
  review: {
    base_url: "https://api.example.com/v1",
    api_key: "your-api-key",
    model: "your-model-name",
    timeout_ms: 45_000,
    max_script_bytes: 20_000,
    max_tool_calls: 3,
    max_retries: DEFAULT_REVIEW_MAX_RETRIES,
    context_messages: 20
  },
  tirith: {
    enabled: DEFAULT_RISK_TOOL.enabled,
    timeout_ms: DEFAULT_RISK_TOOL.timeoutMs,
    fail_open: DEFAULT_RISK_TOOL.failOpen,
  },
  rules: {
    block: blockRules,
    review: reviewRules,
    allow: allowRules,
  },
});

export const defaultConfigJson = (connection: DefaultReviewConnection = DEFAULT_REVIEW_CONNECTION): string => {
  const header = [
    "// CommandApproval config. JSON with comments are supported.",
    "// Project-local config is ignored unless this trusted global file sets allow_local_config to true.",
    "// Enabling it lets every project fully replace this policy; use it only when all opened projects are trusted.",
    "// block rules deny immediately; review rules force LLM review; allow rules skip LLM review.",
    "// tirith uses a configured path or auto-downloads a supported OS/arch binary to a temp cache.",
    "// Any command that matches neither group is reviewed by the configured OpenAI-compatible endpoint.",
    "// Set review.base_url, review.api_key, and review.model explicitly; OpenCode config is not read for LLM review.",
    "// review.max_tool_calls: max read-only tool invocations per review (0 disables tools, default 3).",
    "// review.max_retries: max LLM API retries after the first request (integer 0-10, 0 disables, default 3).",
    "// review.context_messages: recent session messages injected as transcript (0 disables, default 20).",
    "// review.prompt: override the default reviewer policy text (optional).",
  ].join("\n");
  return `${header}\n${JSON.stringify(defaultConfigObject(connection), null, 2)}\n`;
};
