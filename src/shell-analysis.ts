import { withShellTree } from "./shell-parser";
import { createStaticReferenceCollector } from "./static-file-references";
import { byteOffsetsFor, controlCharacterIssue } from "./shell-static";
import {
  addShellIssue,
  MAX_SHELL_SEGMENTS,
  recordShellIssue,
  traverseShellTree,
  type MutableShellAnalysis,
  type ShellAnalysisBudget,
} from "./shell-analysis-traversal";
import type { ShellAnalysis } from "./types";

const MAX_SOURCE_BYTES = 128 * 1024;
const MAX_NESTED_SHELL_DEPTH = 8;

type AnalyzeRequest = {
  readonly source: string;
  readonly nestedDepth: number;
  readonly budget: ShellAnalysisBudget;
  readonly cwd: string;
  readonly referencesEnabled: boolean;
};

const analyze = async ({ source, nestedDepth, budget, cwd, referencesEnabled }: AnalyzeRequest): Promise<ShellAnalysis> => {
  const bytes = Buffer.from(source, "utf8");
  if (bytes.byteLength > MAX_SOURCE_BYTES) {
    return {
      source,
      segments: [],
      redirections: [],
      staticFileReferences: [],
      issues: [{ kind: "limit", reason: "shell command exceeds 128 KiB" }],
      nestedAnalyses: [],
    };
  }
  const controlIssue = controlCharacterIssue(source);
  if (controlIssue) return { source, segments: [], redirections: [], staticFileReferences: [], issues: [controlIssue], nestedAnalyses: [] };
  const state: MutableShellAnalysis = {
    segments: [],
    redirections: [],
    referenceCollector: createStaticReferenceCollector(cwd),
    nestedShells: [],
    issues: new Map(),
    byteOffsets: byteOffsetsFor(source),
    segmentLimitReached: false,
  };
  const nestedAnalyses: ShellAnalysis[] = [];
  await withShellTree(source, (root) => {
    traverseShellTree(root, source, state, budget, nestedDepth > 0);
  });
  if (nestedDepth >= MAX_NESTED_SHELL_DEPTH && state.nestedShells.length > 0) {
    recordShellIssue(state, "limit", "nested shell depth limit exceeded");
  } else {
    for (const nestedSource of state.nestedShells) {
      if (budget.remainingSegments <= 0) {
        recordShellIssue(state, "limit", `shell command exceeds ${String(MAX_SHELL_SEGMENTS)} executable segments`);
        break;
      }
      const nestedAnalysis = await analyze({ source: nestedSource, nestedDepth: nestedDepth + 1, budget, cwd, referencesEnabled: false });
      nestedAnalyses.push(nestedAnalysis);
      state.segments.push(...nestedAnalysis.segments.map((segment) => ({ ...segment, nested: true })));
      for (const nestedIssue of nestedAnalysis.issues) {
        addShellIssue(state, { ...nestedIssue, reason: `nested shell: ${nestedIssue.reason}` });
      }
    }
  }
  return {
    source,
    segments: state.segments.slice(0, MAX_SHELL_SEGMENTS),
    redirections: state.redirections,
    staticFileReferences: referencesEnabled ? state.referenceCollector.references : [],
    issues: [...state.issues.values()],
    nestedAnalyses,
  };
};

export const analyzeShell = async (source: string, cwd = process.cwd()): Promise<ShellAnalysis> =>
  analyze({ source, nestedDepth: 0, budget: { remainingSegments: MAX_SHELL_SEGMENTS }, cwd, referencesEnabled: true });
