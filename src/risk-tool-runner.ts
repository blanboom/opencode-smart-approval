import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { ensureTirithBinary } from "./tirith-download";
import type { CommandContext, ResolvedPolicy } from "./types";

const MAX_TOOL_OUTPUT_CHARS = 64_000;

const TIRITH_FINDING_SCHEMA = z
  .object({
    rule_id: z.string().optional(),
    ruleId: z.string().optional(),
    severity: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

const TIRITH_OUTPUT_SCHEMA = z
  .object({
    summary: z.string().optional(),
    findings: z.array(TIRITH_FINDING_SCHEMA).optional(),
  })
  .passthrough();

type TirithFindingOutput = z.infer<typeof TIRITH_FINDING_SCHEMA>;

export type TirithFinding = {
  readonly ruleId?: string;
  readonly severity?: string;
  readonly title?: string;
  readonly description?: string;
};

export type TirithMetadata = {
  readonly summary: string;
  readonly findings: readonly TirithFinding[];
};

type ProcessOutput = {
  readonly stdout: string;
  readonly stderr: string;
  readonly freshness: "configured" | "current" | "stale_verified";
};

export type TirithProcessRun =
  | (ProcessOutput & {
      readonly kind: "exit";
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
    })
  | (ProcessOutput & {
      readonly kind: "error";
      readonly error: Error;
    })
  | (ProcessOutput & {
      readonly kind: "timeout";
    })
  | {
      readonly kind: "skipped";
      readonly reason: string;
    };

const appendOutput = (current: string, chunk: Buffer | string): string => {
  const next = current + chunk.toString();
  return next.length > MAX_TOOL_OUTPUT_CHARS ? next.slice(0, MAX_TOOL_OUTPUT_CHARS) : next;
};

const normalizeFinding = (finding: TirithFindingOutput): TirithFinding => {
  const ruleId = finding.rule_id ?? finding.ruleId;
  const description = finding.description ?? finding.message;
  return {
    ...(ruleId ? { ruleId } : {}),
    ...(finding.severity ? { severity: finding.severity } : {}),
    ...(finding.title ? { title: finding.title } : {}),
    ...(description ? { description } : {}),
  };
};

export const parseTirithMetadata = (stdout: string): TirithMetadata => {
  const text = stdout.trim();
  if (!text) return { summary: "", findings: [] };
  try {
    const parsed = TIRITH_OUTPUT_SCHEMA.safeParse(JSON.parse(text));
    if (!parsed.success) return { summary: "", findings: [] };
    return {
      summary: parsed.data.summary ?? "",
      findings: (parsed.data.findings ?? []).map(normalizeFinding),
    };
  } catch (error) {
    if (error instanceof SyntaxError) return { summary: "", findings: [] };
    throw error;
  }
};

export const runTirithCompatibleTool = async (
  policy: ResolvedPolicy,
  context: CommandContext,
): Promise<TirithProcessRun> => {
  let stdout = "";
  let stderr = "";
  try {
    const configuredPath = policy.tirith.path;
    if (configuredPath !== undefined && !isAbsolute(configuredPath)) {
      return {
        kind: "error",
        error: new Error("configured tirith.path must be an absolute path"),
        stdout,
        stderr,
        freshness: "configured",
      };
    }
    const executable = configuredPath ?? (await ensureTirithBinary());
    if (typeof executable !== "string" && executable.kind === "skipped") {
      return executable;
    }
    const executablePath = typeof executable === "string" ? executable : executable.path;
    const freshness = typeof executable === "string" ? "configured" : executable.freshness;
    return await new Promise<TirithProcessRun>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: TirithProcessRun): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      };
      const child = spawn(
        executablePath,
        ["check", "--json", "--non-interactive", "--shell", "posix", "--", context.command],
        {
          cwd: context.cwd,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({ kind: "timeout", stdout, stderr, freshness });
      }, policy.tirith.timeoutMs);
      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout = appendOutput(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr = appendOutput(stderr, chunk);
      });
      child.once("error", (error) => {
        finish({ kind: "error", error, stdout, stderr, freshness });
      });
      child.once("close", (exitCode, signal) => {
        finish({ kind: "exit", exitCode, signal, stdout, stderr, freshness });
      });
    });
  } catch (error) {
    if (error instanceof Error) {
      return { kind: "error", error, stdout, stderr, freshness: "configured" };
    }
    throw error;
  }
};
