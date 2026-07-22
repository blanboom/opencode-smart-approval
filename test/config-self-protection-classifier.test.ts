import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { findConfigWrite } from "../src/config-self-protection";
import { canonicalPath } from "../src/path-boundary";
import { analyzeShell } from "../src/shell-analysis";

type ClassificationFixture = {
  readonly directory: string;
  readonly policyPath: string;
  readonly cleanup: () => void;
};

const classificationFixture = (): ClassificationFixture => {
  const root = mkdtempSync(join(tmpdir(), "approval-self-protection-classifier-"));
  const directory = join(root, "project");
  mkdirSync(join(directory, "subdir"), { recursive: true });
  return {
    directory,
    policyPath: join(directory, "command-approval.jsonc"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};

const classifyShell = async (command: string, fixture: ClassificationFixture) => findConfigWrite({
  tool: "bash",
  args: { command },
  directory: fixture.directory,
  policyPaths: [fixture.policyPath],
  analysis: await analyzeShell(command, fixture.directory),
});

describe("approval configuration mutation classifier", () => {
  test.each([
    "printf '{}' > command-approval.jsonc",
    "git restore command-approval.jsonc",
    "git restore -- command-approval.jsonc",
    "git checkout -- command-approval.jsonc",
    "curl -o command-approval.jsonc https://example.invalid/policy",
    "curl --output=command-approval.jsonc https://example.invalid/policy",
    "mv command-approval.jsonc policy.backup",
    "ln command-approval.jsonc policy-hardlink.jsonc",
    "git rm -- command-approval.jsonc",
    "git config --file command-approval.jsonc approval.enabled false",
    "git config -f command-approval.jsonc approval.enabled false",
    "git config -fcommand-approval.jsonc approval.enabled false",
    "git config --file=command-approval.jsonc approval.enabled false",
    "ln unrelated.txt command-approval.jsonc",
    "ln -s unrelated.txt command-approval.jsonc",
    "touch -r unrelated.txt command-approval.jsonc",
    "touch -runrelated.txt command-approval.jsonc",
    "touch --reference unrelated.txt command-approval.jsonc",
    "touch --reference=unrelated.txt command-approval.jsonc",
    "find . -fprint command-approval.jsonc",
    "find . -fprint0 command-approval.jsonc",
    "find . -fprintf command-approval.jsonc '%p\\n'",
    "find . -fls command-approval.jsonc",
    "rsync --log-file command-approval.jsonc /tmp/source /tmp/destination",
    "rsync --log-file=command-approval.jsonc /tmp/source /tmp/destination",
    "rsync --write-batch command-approval.jsonc /tmp/source /tmp/destination",
    "rsync --write-batch=command-approval.jsonc /tmp/source /tmp/destination",
    "rsync --only-write-batch command-approval.jsonc /tmp/source /tmp/destination",
    "rsync --only-write-batch=command-approval.jsonc /tmp/source /tmp/destination",
    "git archive -o command-approval.jsonc HEAD",
    "git archive -ocommand-approval.jsonc HEAD",
    "git archive --output command-approval.jsonc HEAD",
    "git archive --output=command-approval.jsonc HEAD",
    "git bundle create command-approval.jsonc --all",
    "/usr/bin/time -o command-approval.jsonc cat /tmp/input",
    "/usr/bin/time -ocommand-approval.jsonc cat /tmp/input",
    "/usr/bin/time --output command-approval.jsonc cat /tmp/input",
    "/usr/bin/time --output=command-approval.jsonc cat /tmp/input",
    "/usr/bin/time -o command-approval.jsonc env -C subdir cat /tmp/input",
  ])("classifies a proven active policy write as block: %s", async (command) => {
    // Given the project policy is reload-effective and shell analysis is already available.
    const fixture = classificationFixture();
    try {
      // When the shared analysis is classified for self-protection.
      const finding = await classifyShell(command, fixture);

      // Then an exact proven mutation is terminally blocked.
      expect(finding).toMatchObject({ action: "block", path: canonicalPath(fixture.policyPath) });
    } finally {
      fixture.cleanup();
    }
  });

  test.each([
    "python -c \"open('command-' + 'approval.jsonc', 'w').write('{}')\"",
    "bash -c \"printf '{}' > command-approval.jsonc\"",
    "env bash -c \"printf '{}' > command-approval.jsonc\"",
    "nice sh -c \"printf '{}' > command-approval.jsonc\"",
    "node -e \"require('fs').writeFileSync('command-approval.jsonc', '{}')\"",
    "perl -pi -e 's/a/b/' command-approval.jsonc",
    "target=command-approval.jsonc; printf '{}' > \"$target\"",
    "name=command-approval; printf '{}' > \"$name.jsonc\"",
    "git reset --hard",
    "git checkout command-approval.jsonc",
    "git restore .",
    "git checkout -- .",
    "git merge feature-branch",
    "git worktree add ../review-worktree HEAD",
    "rm -rf .",
    "tar -xf payload.tar",
    "unzip payload.zip",
    "curl -o \"$target\" https://example.invalid/policy",
    "target=command-approval.jsonc; rm \"$target\"",
    "target=command-approval.jsonc; cp payload \"$target\"",
    "git -C subdir restore ../command-approval.jsonc",
    "unknown-writer command-approval.jsonc",
    "ln \"$source\" unrelated-hardlink",
    "ln unrelated.txt \"$destination\"",
    "ln -s unrelated.txt \"$destination\"",
    "touch -r unrelated.txt \"$destination\"",
    "cat > \"$output\"",
    "cat >> \"$output\"",
    "find . -fprint \"$output\"",
    "rsync --log-file \"$output\" /tmp/source /tmp/destination",
    "git archive -o \"$output\" HEAD",
    "git bundle create \"$output\" --all",
    "/usr/bin/time -o \"$output\" cat /tmp/input",
  ])("classifies an ambiguous policy-capable mutation as force_review: %s", async (command) => {
    // Given an operation whose policy effect cannot be proved from static shell facts.
    const fixture = classificationFixture();
    try {
      // When the existing shell analysis is classified without reparsing.
      const finding = await classifyShell(command, fixture);

      // Then trusted allow shortcuts cannot treat it as definitively safe.
      expect(finding).toMatchObject({ action: "force_review" });
    } finally {
      fixture.cleanup();
    }
  });

  test.each([
    "cat command-approval.jsonc",
    "echo command-approval.jsonc",
    "printf '%s\\n' command-approval.jsonc",
    "policy_name=command-approval.jsonc",
    "POLICY=command-approval.jsonc printf '{}' > unrelated.jsonc",
    "printf '{}' > unrelated.jsonc",
    "cp command-approval.jsonc /tmp/policy-backup",
    "git diff -- command-approval.jsonc",
    "git config -f=command-approval.jsonc approval.enabled false",
    "ln -s command-approval.jsonc unrelated-symlink",
    "ln --symbolic command-approval.jsonc unrelated-symlink",
    "ln -s \"$source\" unrelated-symlink",
    "touch -r command-approval.jsonc unrelated.txt",
    "touch -rcommand-approval.jsonc unrelated.txt",
    "touch --reference command-approval.jsonc unrelated.txt",
    "touch --reference=command-approval.jsonc unrelated.txt",
    "touch -r \"$reference\" unrelated.txt",
    "cat < command-approval.jsonc",
    "cat < \"$input\"",
    "cat 0< \"$input\"",
    "find command-approval.jsonc -print",
    "find command-approval.jsonc -fprint /tmp/find-output",
    "rsync command-approval.jsonc /tmp/policy-backup --log-file=/tmp/rsync.log",
    "git archive --output=/tmp/policy.tar HEAD command-approval.jsonc",
    "git bundle verify command-approval.jsonc",
    "/usr/bin/time -o /tmp/time.log cat command-approval.jsonc",
    "/usr/bin/time -o ../command-approval.jsonc env -C subdir cat /tmp/input",
  ])("classifies a proven non-policy mutation as none: %s", async (command) => {
    // Given a read, filename print, inert assignment, or unrelated static output.
    const fixture = classificationFixture();
    try {
      // When the command is classified against the active path.
      const finding = await classifyShell(command, fixture);

      // Then self-protection does not create a false block or forced review.
      expect(finding).toEqual({ action: "none" });
    } finally {
      fixture.cleanup();
    }
  });

  test("normalizes dot segments and existing symlinks before exact path comparison", () => {
    // Given two lexical spellings that resolve to the reload-effective policy.
    const fixture = classificationFixture();
    try {
      writeFileSync(fixture.policyPath, "{}");
      const symlinkPath = join(fixture.directory, "policy-link.jsonc");
      symlinkSync(fixture.policyPath, symlinkPath);

      // When direct file writes target the normalized and symlink spellings.
      const normalized = findConfigWrite({
        tool: "write",
        args: { filePath: join(fixture.directory, "subdir", "..", "command-approval.jsonc") },
        directory: fixture.directory,
        policyPaths: [fixture.policyPath],
      });
      const symlink = findConfigWrite({
        tool: "write",
        args: { filePath: symlinkPath },
        directory: fixture.directory,
        policyPaths: [fixture.policyPath],
      });

      // Then both are classified as exact writes without claiming race-free OS enforcement.
      expect(normalized).toMatchObject({ action: "block", path: canonicalPath(fixture.policyPath) });
      expect(symlink).toMatchObject({ action: "block", path: canonicalPath(fixture.policyPath) });
    } finally {
      fixture.cleanup();
    }
  });
});
