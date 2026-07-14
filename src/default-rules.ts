import { compileRule } from "./rule-compiler";
import type { CommandRule, RuleDecision } from "./types";

type BuiltinDefinition = {
  readonly match: string;
  readonly decision: RuleDecision;
  readonly reason: string;
};

const ghPrefix = "(?:/opt/homebrew/bin/)?gh(?:(?:\\s+-R(?:\\s+\\S+|\\S+))|(?:\\s+--(?:repo|hostname)(?:=\\S+|\\s+\\S+)))*";
const shellWord = "(?:'[^']*'|\"(?:\\\\.|[^\"\\\\])*\"|\\S+)";
const gitGlobal = `(?:-(?:C|c)(?:\\s+${shellWord}|\\S+)|--(?:no-pager|no-optional-locks|no-replace-objects|literal-pathspecs|glob-pathspecs|noglob-pathspecs|icase-pathspecs))`;
const gitPrefix = `(?:(?:/usr/bin/|/opt/homebrew/bin/)?git)(?:\\s+${gitGlobal})*`;

const definitions = [
  {
    decision: "review",
    match: `^${gitPrefix}\\s+push(?:\\s|$).*`,
    reason: "git push needs review for its remote and branch effects",
  },
  {
    decision: "review",
    match: "^(?:(?:/usr/bin/|/opt/homebrew/bin/)?(?:npm|pnpm|yarn))\\s+publish(?:\\s|$).*",
    reason: "package publishing is a public, irreversible action",
  },
  {
    decision: "review",
    match: "^(?:(?:/usr/bin/|/opt/homebrew/bin/)?(?:docker|podman))\\s+(?:push|build\\b.*--push)(?:\\s|$).*",
    reason: "container registry writes need explicit review",
  },
  {
    decision: "allow",
    match:
      "^(?:(?:/usr/bin/|/bin/|/opt/homebrew/bin/)?(?:grep|egrep|fgrep|head|tail|wc|cut|tr|nl|jq|comm|join|paste|fold|fmt|rg|sed|sort|base64|file|ffprobe|cat))(?:\\s|$).*",
    reason: "static stdout filter or read-only file inspector",
  },
  {
    decision: "allow",
    match:
      "^(?:(?:/bin/)?(?:echo|true|false|sleep|test|\\[)|(?:/usr/bin/)?printf)(?:\\s|$).*",
    reason: "harmless shell glue command",
  },
  {
    decision: "allow",
    match:
      "^(?:(?:/usr/bin/|/bin/|/sbin/|/usr/sbin/|/opt/homebrew/bin/)?(?:ls|pwd|basename|dirname|readlink|realpath|which|stat|strings|shasum|cksum|md5|date|uname|whoami|id|df|du|sw_vers))(?:\\s|$).*",
    reason: "read-only host or filesystem inspection",
  },
  {
    decision: "allow",
    match: "^(?:/usr/bin/)?command\\s+-v(?:\\s|$).*",
    reason: "command lookup without execution",
  },
  {
    decision: "allow",
    match:
      `^${gitPrefix}\\s+(?:--version|status|log|show|diff|grep|rev-parse|rev-list|ls-files|ls-tree|blame|describe|name-rev|shortlog|whatchanged|merge-base|for-each-ref|show-ref)(?:\\s|$).*`,
    reason: "bounded read-only git inspection",
  },
  {
    decision: "allow",
    match: `^${gitPrefix}\\s+branch(?:\\s|$).*`,
    reason: "git branch command bounded by mandatory listing-only guards",
  },
  {
    decision: "allow",
    match: `^${gitPrefix}\\s+tag(?:\\s|$).*`,
    reason: "git tag command bounded by mandatory listing-only guards",
  },
  {
    decision: "allow",
    match: `^${gitPrefix}\\s+stash\\s+(?:list|show)(?:\\s|$).*`,
    reason: "git stash inspection",
  },
  {
    decision: "allow",
    match: `^${ghPrefix}\\s+(?:status|version)(?:\\s|$).*`,
    reason: "GitHub CLI status or version inspection",
  },
  {
    decision: "allow",
    match:
      `^${ghPrefix}\\s+(?:pr\\s+(?:view|list|status|checks|diff)|issue\\s+(?:view|list|status)|run\\s+(?:view|list|watch)|workflow\\s+(?:view|list)|repo\\s+(?:view|list)|release\\s+(?:view|list)|search\\s+(?:code|commits|issues|prs|repos)|auth\\s+status)(?:\\s|$).*`,
    reason: "bounded read-only GitHub inspection",
  },
  {
    decision: "allow",
    match: "^(?:/usr/bin/)?pgrep(?:\\s|$).*",
    reason: "process listing",
  },
  {
    decision: "allow",
    match: "^(?:/bin/)?launchctl\\s+print(?:\\s|$).*",
    reason: "launchd state inspection",
  },
  {
    decision: "allow",
    match: "^(?:/usr/bin/)?log\\s+stream(?:\\s|$).*",
    reason: "system log streaming",
  },
  {
    decision: "allow",
    match:
      "^(?:/usr/bin/)?security\\s+(?:find-identity|find-certificate|show-keychain-info)(?:\\s|$).*",
    reason: "non-secret keychain metadata inspection",
  },
  {
    decision: "allow",
    match: "^(?:/usr/sbin/)?diskutil\\s+(?:list|info)(?:\\s|$).*",
    reason: "disk metadata inspection",
  },
  {
    decision: "allow",
    match: "^(?:/usr/sbin/)?diskutil\\s+apfs\\s+listSnapshots(?:\\s|$).*",
    reason: "APFS snapshot listing",
  },
  {
    decision: "allow",
    match: "^(?:/usr/bin/)?hdiutil\\s+info(?:\\s|$).*",
    reason: "disk image metadata inspection",
  },
  {
    decision: "allow",
    match: "^(?:/usr/bin/)?tmutil\\s+listlocalsnapshots(?:\\s|$).*",
    reason: "Time Machine local snapshot listing",
  },
] as const satisfies readonly BuiltinDefinition[];

const compiledRules = definitions.map((definition, index) =>
  compileRule({
    label: `builtin[${String(index)}]`,
    match: definition.match,
    decision: definition.decision,
    reason: definition.reason,
    scope: "segment",
    priority: 0,
    origin: "builtin",
  }),
);

export const defaultRules = (): readonly CommandRule[] => compiledRules;
