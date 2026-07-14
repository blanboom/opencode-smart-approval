import { describe, expect, test } from "bun:test";
import { evaluateRules } from "../src/rules";
import { userPolicy } from "./user-command-policy-helpers";

describe("Codex-derived user command allow policy", () => {
  test.each([
    "xcodebuildmcp tools | grep simulator",
    "sim-use list | head -n 1",
    "xcrun simctl list | grep Booted",
    "asc testflight builds list | jq '.data | length'",
    "swift test",
    "swift build",
    "git commit -S -m test",
    "git -c commit.gpgsign=true commit -m test",
    "git -c commit.gpgsign=true -C repo commit -m test",
    "git -C 'path with spaces' -c user.signingkey=ABC commit -S -m test",
    `git -c "commit.gpgsign=true" commit -m test`,
    "git -c commit.gpgSign=true commit -m test",
    "git --no-pager commit -S -m test",
    "git --no-optional-locks -C repo commit -S -m test",
    "git --no-replace-objects -c commit.gpgsign=true commit -m test",
    "git commit -m '.env'",
    "git commit --no-verbose -m test",
    "xcodebuildmcp --help; printf '--- list ---\\n'; xcodebuildmcp tools",
    "asc --help | sed -n '1,120p'",
    "HOME=/tmp xcodebuildmcp tools",
    "DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -version",
    "LIVE_WEBENGINE=1 swift test",
    "env SIMCTL_CHILD_FOO=1 xcrun simctl list",
    "xcrun simctl list 2>&1 | grep Booted",
    "xcodebuildmcp tools 2>/dev/null | grep simulator",
    "time xcodebuild -version",
    "xcrun swift -help",
    "xcrun swift -print-target-info",
    "xcrun swift -print-supported-features",
    "xcrun swift -typecheck Source.swift",
    "xcrun --find rm",
    "xcodebuildmcp tools > /tmp/xcodebuildmcp-tools.json",
  ])("allows explicitly trusted user command: %s", async (command) => {
    const evaluation = await evaluateRules(userPolicy().rules, { command });
    const expected = process.platform !== "darwin" && command.startsWith("xcrun ") ? "review" : "allow";
    expect(evaluation.decision).toBe(expected);
  });
});
