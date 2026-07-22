import { describe, expect, test } from "bun:test";
import { BoundedOutput, requireUniqueStartupOrigin } from "../scripts/opencode-e2e/output";
import {
  buildLsofFilesCommand,
  buildLsofNetworkCommand,
  parseLsofExit,
  parseLsofFileNames,
  requireNoOwnerOpenCodePaths,
} from "../scripts/opencode-e2e/sampler";
import { buildTerminationPlan } from "../scripts/opencode-e2e/teardown";

describe("bounded OpenCode process output", () => {
  test("retains at most 65,536 UTF-8 bytes and records truncation", () => {
    // Given output that crosses the hard capture boundary.
    const capture = new BoundedOutput(65_536);

    // When two chunks exceed it.
    capture.append("a".repeat(65_530));
    capture.append("0123456789");

    // Then the retained bytes are capped while total bytes and truncation remain explicit.
    expect(capture.snapshot()).toEqual({
      text: `${"a".repeat(65_530)}012345`,
      retainedBytes: 65_536,
      totalBytes: 65_540,
      truncated: true,
    });
  });

  test("requires one exact loopback startup line", () => {
    // Given one valid startup capture and duplicate, foreign-host, and malformed variants.
    const valid = "boot\nopencode server listening on http://127.0.0.1:43210\n";
    const duplicate = `${valid}opencode server listening on http://127.0.0.1:43211\n`;
    const foreign = "opencode server listening on http://0.0.0.0:43210\n";
    const malformed = "opencode server listening on http://127.0.0.1:0\n";

    // When each complete capture is parsed.
    // Then only the single exact startup line yields the server origin.
    expect(requireUniqueStartupOrigin(valid)).toEqual({ origin: "http://127.0.0.1:43210", port: 43_210 });
    expect(() => requireUniqueStartupOrigin(duplicate)).toThrow("startup");
    expect(() => requireUniqueStartupOrigin(foreign)).toThrow("startup");
    expect(() => requireUniqueStartupOrigin(malformed)).toThrow("startup");
  });
});

describe("owned PID monitoring and teardown", () => {
  test("uses the exact required lsof commands and retains macOS exit-one matches", () => {
    // Given one exact owned PID and lsof process results.
    const pid = 420;

    // When commands and exit states are interpreted.
    // Then no broad process discovery is introduced and only an empty exit-one is benign.
    expect(buildLsofNetworkCommand(pid)).toEqual([
      "/usr/sbin/lsof", "-nP", "-a", "-p", "420", "-iTCP", "-iUDP", "-w",
    ]);
    expect(buildLsofFilesCommand(pid)).toEqual([
      "/usr/sbin/lsof", "-nP", "-a", "-p", "420", "-Fn", "-w",
    ]);
    expect(parseLsofExit(0, "header", "")).toBe("header");
    expect(parseLsofExit(1, "", "")).toBe("");
    expect(parseLsofExit(1, "header", "")).toBe("header");
    expect(() => parseLsofExit(2, "", "denied")).toThrow("socket");
  });

  test("records absolute opened files and rejects owner OpenCode state", () => {
    // Given lsof field output containing system, workspace, and owner OpenCode paths.
    const output = [
      "p420",
      "n/usr/lib/dyld",
      "n/Users/owner/Workspace/plugin/src/index.ts",
      "n/Users/owner/.config/opencode/opencode.jsonc",
      "n127.0.0.1:43124",
    ].join("\n");

    // When opened-file names are parsed and checked against the explicit owner home.
    const paths = parseLsofFileNames(output);

    // Then only absolute paths are retained and owner OpenCode state fails closed.
    expect(paths).toEqual([
      "/Users/owner/.config/opencode/opencode.jsonc",
      "/Users/owner/Workspace/plugin/src/index.ts",
      "/usr/lib/dyld",
    ]);
    expect(() => requireNoOwnerOpenCodePaths(paths, "/Users/owner")).toThrow("environment");
    expect(() => requireNoOwnerOpenCodePaths(paths.slice(1), "/Users/owner")).not.toThrow();
  });

  test("signals exact unique PIDs once and escalates only survivors", () => {
    // Given duplicate observations and one process that survives SIGTERM.
    const observed = [420, 421, 420];

    // When the deterministic signal plan is built from the post-TERM live set.
    const plan = buildTerminationPlan(observed, [421]);

    // Then TERM covers exact unique ownership and KILL covers only the exact survivor.
    expect(plan).toEqual({ term: [420, 421], kill: [421] });
    expect(() => buildTerminationPlan(observed, [999])).toThrow("process");
  });
});
