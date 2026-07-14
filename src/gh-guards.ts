import type { CommandInvocation } from "./command-invocation";
import { guardFinding, type GuardFinding } from "./guard-types";

type GhInvocation = {
  readonly route: string;
  readonly arguments: readonly string[];
  readonly unsafeGlobalOption?: string;
};

const parseGhInvocation = (invocation: CommandInvocation): GhInvocation => {
  const args = invocation.arguments;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) break;
    if (["-R", "--repo", "--hostname"].includes(argument)) {
      index += 1;
      continue;
    }
    if (/^(?:-R.+|--(?:repo|hostname)=.+)$/u.test(argument)) continue;
    if (argument.startsWith("-")) return { route: "", arguments: [], unsafeGlobalOption: argument };
    const next = args[index + 1];
    const oneLevel = ["api", "status", "version"].includes(argument);
    const route = [argument, !oneLevel && next && !next.startsWith("-") ? next : undefined].filter(Boolean).join(" ");
    return {
      route,
      arguments: args.slice(index + (route.includes(" ") ? 2 : 1)),
    };
  }
  return { route: "", arguments: [] };
};

const ghApiWrites = (args: readonly string[]): boolean => {
  let method: string | undefined;
  let hasFieldOrInput = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    const compactMethod = argument.match(/^(?:-X=?|--method=)([A-Za-z]+)$/u)?.[1];
    if (compactMethod) method = compactMethod.toUpperCase();
    else if (argument === "-X" || argument === "--method") method = (args[index + 1] ?? "").toUpperCase();
    if (/^(?:-[fF].+|--(?:field|raw-field|input)(?:=|$))/u.test(argument) || argument === "-f" || argument === "-F") {
      hasFieldOrInput = true;
    }
  }
  return method ? !["GET", "HEAD"].includes(method) : hasFieldOrInput;
};

const safeGhRoute = /^(?:status|version|auth status|pr (?:view|list|status|checks|diff)|issue (?:view|list|status)|run (?:view|list|watch)|workflow (?:view|list)|repo (?:view|list)|release (?:view|list)|search (?:code|commits|issues|prs|repos))$/u;
const blockedGhRoute = /^(?:repo (?:delete|create|edit|rename|archive|unarchive)|release (?:create|delete|edit|upload)|workflow (?:run|enable|disable)|run (?:cancel|delete|rerun)|auth (?:login|logout|refresh|setup-git|switch|token)|(?:secret|variable)(?: |$)|(?:ssh-key|gpg-key) (?:add|delete))$/u;

const falseBooleanValues = new Set(["0", "f", "false"]);

const booleanValueIsFalse = (value: string | undefined): boolean =>
  value !== undefined && falseBooleanValues.has(value.toLowerCase());

const compactBooleanEnabled = (argument: string, flag: string, companions: string): boolean => {
  const matched = argument.match(/^-([A-Za-z]+)(?:=([^=]+))?$/u);
  if (!matched?.[1]?.includes(flag) || [...matched[1]].some((value) => !companions.includes(value))) return false;
  if (!booleanValueIsFalse(matched[2])) return true;
  return matched[1].lastIndexOf(flag) < matched[1].length - 1;
};

const longBooleanEnabled = (argument: string, option: string): boolean => {
  if (argument === option) return true;
  if (!argument.startsWith(`${option}=`)) return false;
  return !booleanValueIsFalse(argument.slice(option.length + 1));
};

export const evaluateGhGuard = (invocation: CommandInvocation): GuardFinding | undefined => {
  const parsed = parseGhInvocation(invocation);
  const args = parsed.arguments;
  if (parsed.route === "auth status" && args.some((argument) =>
    compactBooleanEnabled(argument, "t", "at") || longBooleanEnabled(argument, "--show-token")
  )) {
    return guardFinding("block", "github_token", "GitHub token display would expose a credential");
  }
  if (blockedGhRoute.test(parsed.route) || (parsed.route === "api" && ghApiWrites(args))) {
    return guardFinding("block", "github_admin", "GitHub admin, auth, secret, release, workflow, or write API operation needs explicit control");
  }
  if (parsed.unsafeGlobalOption) {
    return guardFinding("review", "github_global_option", "unknown GitHub CLI global option requires review");
  }
  if (args.some((argument) => compactBooleanEnabled(argument, "w", "cw") || longBooleanEnabled(argument, "--web"))) {
    return guardFinding("review", "github_web", "opening GitHub in a browser requires review");
  }
  if (!safeGhRoute.test(parsed.route)) {
    return guardFinding("review", "github_effectful", "GitHub command is outside the bounded read-only command set");
  }
  return undefined;
};
