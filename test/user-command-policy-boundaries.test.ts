import { describe, expect, test } from "bun:test";
import { defaultPolicy } from "../src/default-config";
import { evaluateRules } from "../src/rules";
import { userPolicy } from "./user-command-policy-helpers";

describe("Codex-derived user command policy boundaries", () => {
  test("keeps safe GitHub inspection commands in generic defaults", async () => {
    for (const command of [
      "gh pr view 42",
      "gh -R owner/repo pr view 42",
      "gh --repo owner/repo issue list",
      "gh --hostname github.com status",
      "git -C repo status",
      "git --no-pager log -1",
      "git --no-optional-locks status",
      "git -C repo --no-pager diff --stat",
    ]) {
      expect((await evaluateRules(defaultPolicy().rules, { command })).decision, command).toBe("allow");
    }
  });

  test.each(["xcrun simctl list", "swift build", "xcodebuild -version"])(
    "does not ship iOS-only authorization in defaults: %s",
    async (command) => {
      expect((await evaluateRules(defaultPolicy().rules, { command })).decision).toBe("review");
    },
  );

  test("keeps mandatory git hook bypass protection above user priority", async () => {
    for (const command of [
      "git commit --no-verify -m test",
      "git -C repo commit -n -m test",
      "git -c commit.gpgsign=true commit -n -m test",
      "git commit --n\\o-verify -m test",
      "git commit -F ~/.ssh/id_rsa",
      "xcrun clangd --check=~/.ssh/id_rsa",
      "xcrun tapi installapi ~/.ssh/id_rsa",
      "xcrun xctrace record --template ~/.ssh/id_rsa",
      "xcrun ipatool --help",
      "xcrun appintentsmetadataprocessor --source-file-list ~/.ssh/id_rsa",
      "xcrun otool -L ~/.ssh/id_rsa",
      "xcrun c89 -E ~/.ssh/id_rsa",
      "xcrun agent claude -p run",
      "xcrun mcpbridge run-agent claude -p run",
      "xcrun mcpbridge run-agent --dry-run claude -p run",
    ]) {
      expect((await evaluateRules(userPolicy().rules, { command })).decision, command).toBe("block");
    }
  });

  test("keeps trusted Xcode-tree xcrun commands allowed", async () => {
    for (const command of [
      "xcrun simctl list",
      "xcrun --find swift",
      "xcrun swift --version",
      "xcrun swift package --help",
      "xcrun swift package describe",
      "xcrun swift sdk list",
      "xcrun --sdk iphonesimulator simctl list",
      "xcrun --toolchain com.apple.dt.toolchain.XcodeDefault swift -typecheck Source.swift",
      "xcrun clang -x c -fsyntax-only Source.c",
      "xcrun swiftc -typecheck Source.swift",
      "xcodebuild CODE_SIGNING_ALLOWED=NO build",
      "xcodebuild -sdk iphonesimulator -version",
      "xcodebuild -toolchain com.apple.dt.toolchain.XcodeDefault build",
      "xcodebuild TOOLCHAINS=com.apple.dt.toolchain.XcodeDefault build",
      "xcodebuild SDKROOT=iphonesimulator build",
      "xcodebuild OTHER_CFLAGS=-Wall build",
      "xcodebuild OTHER_SWIFT_FLAGS=-warnings-as-errors build",
      "xcrun swift-build",
      "xcrun swift-test",
      "xcrun swift-package describe",
      "xcrun cc -E Source.c",
      "xcrun dsymutil App",
      "xcrun ld -o App input.o",
      "xcrun bison input.y",
      "xcrun leaks 123",
      "xcrun xctrace list devices",
      "xcrun xccov generate --toolchain XcodeDefault --json '{}'",
    ]) {
      const expected = process.platform === "darwin" ? "allow" : "review";
      expect((await evaluateRules(userPolicy().rules, { command })).decision, command).toBe(expected);
    }
  });
});
