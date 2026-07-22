import type { ShellWord } from "./types";

export type OutputTargetAnalysis = {
  readonly ambiguous: boolean;
  readonly exactTargets: readonly string[];
};

const attachedTarget = (argument: string, options: ReadonlySet<string>): string | undefined => {
  for (const option of options) {
    if (option.startsWith("--") && argument.startsWith(`${option}=`)) {
      return argument.slice(option.length + 1);
    }
    if (option.length === 2 && argument.startsWith(option) && argument.length > 2) {
      return argument.slice(option.length);
    }
  }
  return undefined;
};

export const outputOptionTargets = (
  words: readonly ShellWord[],
  options: ReadonlySet<string>,
): OutputTargetAnalysis => {
  const exactTargets: string[] = [];
  let ambiguous = false;
  let optionsEnded = false;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (!word) continue;
    if (!optionsEnded && word.value === "--") {
      optionsEnded = true;
      continue;
    }
    if (optionsEnded) continue;
    const attached = attachedTarget(word.value, options);
    if (attached !== undefined) {
      if (attached.length > 0) exactTargets.push(attached);
      if (attached.length === 0 || !word.expansionFree) ambiguous = true;
      continue;
    }
    if (!options.has(word.value)) continue;
    const target = words[index + 1];
    if (!target) {
      ambiguous = true;
      continue;
    }
    if (target.value.length > 0) exactTargets.push(target.value);
    if (target.value.length === 0 || !target.expansionFree) ambiguous = true;
    index += 1;
  }
  return { ambiguous, exactTargets };
};
