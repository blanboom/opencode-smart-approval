import { compileRule } from "./rule-compiler";
import type { CommandRule } from "./types";

type BuiltinDefinition = {
  readonly match: string;
  readonly reason: string;
};

const staticArguments = "(?:\\s+[^\\r\\n]*)?\\s*$";

const definitions = [
  {
    match: `^(?:/bin/)?(?:true|false|test|\\[)${staticArguments}`,
    reason: "shell predicates without redirection",
  },
  {
    match: `^(?:(?:/usr/bin/|/bin/)?(?:ls|pwd|basename|dirname))${staticArguments}`,
    reason: "basic location or directory inspection without redirection",
  },
  {
    match: `^(?:/usr/bin/)?command\\s+-v(?:\\s+[^\\r\\n]*)?\\s*$`,
    reason: "command lookup without execution or redirection",
  },
] as const satisfies readonly BuiltinDefinition[];

const compiledRules = definitions.map((definition, index) =>
  compileRule({
    label: `builtin.allow[${String(index)}]`,
    match: definition.match,
    decision: "allow",
    reason: definition.reason,
    scope: "segment",
    priority: 0,
    origin: "builtin",
  }),
);

export const defaultRules = (): readonly CommandRule[] => compiledRules;
