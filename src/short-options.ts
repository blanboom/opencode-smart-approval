import type { CommandArgument } from "./command-invocation";

export type ShortOptionRole = "flag" | "path" | "value";

export type ParsedShortOption = {
  readonly name: string;
  readonly role: ShortOptionRole;
  readonly argument: CommandArgument;
  readonly value?: CommandArgument;
  readonly consumesNext: boolean;
};

export const rawAttachedValue = (argument: CommandArgument, value: string): string => {
  const raw = argument.raw;
  if (raw.startsWith("'") || raw.startsWith('"')) return `${raw.charAt(0)}${value}`;
  const offset = raw.lastIndexOf(value);
  if (offset < 0) return value;
  const prefix = raw.charAt(offset - 1);
  return prefix === "'" || prefix === '"' || prefix === "\\"
    ? raw.slice(offset - 1)
    : raw.slice(offset);
};

export const parseShortOptionToken = (
  argument: CommandArgument,
  next: CommandArgument | undefined,
  roles: Readonly<Record<string, ShortOptionRole>>,
): readonly ParsedShortOption[] => {
  if (!/^-[^-].*/u.test(argument.value) || argument.value === "-") return [];
  const body = argument.value.slice(1);
  const parsed: ParsedShortOption[] = [];
  for (let index = 0; index < body.length; index += 1) {
    const name = body.charAt(index);
    const role = roles[name] ?? "flag";
    if (role === "flag") {
      parsed.push({ name, role, argument, consumesNext: false });
      continue;
    }
    const attached = body.slice(index + 1).replace(/^=/u, "");
    const value = attached
      ? { raw: rawAttachedValue(argument, attached), value: attached }
      : next;
    parsed.push({ name, role, argument, ...(value ? { value } : {}), consumesNext: !attached });
    break;
  }
  return parsed;
};

export const hasShortOption = (
  args: readonly CommandArgument[],
  name: string,
  roles: Readonly<Record<string, ShortOptionRole>> = {},
): boolean => args.some((argument, index) =>
  parseShortOptionToken(argument, args[index + 1], roles).some((option) => option.name === name)
);
