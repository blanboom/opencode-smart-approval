import type { RuleDecision } from "./types";

const legacyGeneratedAllows = new Set([
  "^(?!.*(?:&&|\\|\\||[;&|<>`]|\\$\\(|<\\(|>\\(|[\\r\\n]))(?:pwd|which|date|uname|whoami|id|df|du|stat|sw_vers|jq|ls|head|tail|rg|wc|grep|cat|sort|file|ffprobe|echo|printf|true|false|expr|cut|nl|paste|rev|seq|tr|uniq|base64)(?:\\s|$).*",
  "^(?!.*(?:&&|\\|\\||[;&|<>`]|\\$\\(|<\\(|>\\(|[\\r\\n]))(?:node|bun|npm|pnpm|yarn|python3?|pip3?|cargo|rustc|go|swift|xcodebuild|opencode|gh|git)\\s+(?:--version|-v|-version|version|--help|-h|help)\\s*$",
  "^(?!.*(?:&&|\\|\\||[;&|<>`]|\\$\\(|<\\(|>\\(|[\\r\\n]))git\\s+(?:status|diff|log|show|branch|rev-parse|ls-files|grep|blame|fetch|describe|reflog|remote\\s+(?:-v|show)|config\\s+(?:--get|--list)|stash\\s+(?:list|show)|tag\\s+(?:--list|-l))(?:\\s|$).*",
  "^(?!.*(?:&&|\\|\\||[;&|<>`]|\\$\\(|<\\(|>\\(|[\\r\\n]))(?:(?:npm|pnpm|yarn|bun)\\s+(?:test|run\\s+(?:test|typecheck|lint|build))\\b|python3?\\s+-m\\s+pytest\\b(?!.*(?:\\s--pyargs\\b|\\s/|\\.\\.))|pytest\\b(?!.*(?:\\s--pyargs\\b|\\s/|\\.\\.))|swift\\s+(?:test|build)\\b|cargo\\s+(?:test|build|check)\\b|go\\s+test\\b).*",
  "^(?!.*(?:&&|\\|\\||[;&|<>`]|\\$\\(|<\\(|>\\(|[\\r\\n]))(?:plutil\\s+-lint|defaults\\s+read|mdls|codesign\\s+-d|otool\\s+-L|lipo\\s+-info|xcrun\\s+simctl\\s+(?:list|bootstatus|get_app_container|listapps))(?:\\s|$).*",
  "^(?!.*(?:&&|\\|\\||[;&|<>`]|\\$\\(|<\\(|>\\(|[\\r\\n]))(?:mkdir|touch|cp)(?:\\s|$).*",
]);

export const isLegacyGeneratedRule = (decision: RuleDecision, match: string): boolean =>
  decision === "allow" && legacyGeneratedAllows.has(match);
