# opencode-smart-approval

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A plugin for [OpenCode](https://github.com/sst/opencode) that safely reduces shell-command approval cost with [Tirith](https://github.com/sheeki03/tirith), Tree-sitter shell analysis, deterministic rules, and an LLM reviewer with read-only tools.

OpenCode does not provide a command sandbox. Deterministic allows are therefore deliberately limited to commands and options that are safe with the user's full host permissions.

## How it works

Every shell command (`bash`, `shell`, `exec_command`, etc.) follows this pipeline:

```
Raw command → Tirith → Shell parse → Mandatory guards → Per-segment rules → Aggregate → LLM if needed
```

| Stage | Action |
|-------|--------|
| **Tirith** | Scans the complete, unsplit raw command first. A block is final; a warning forces LLM review. |
| **Shell analysis** | A pinned Tree-sitter Bash grammar extracts static executable segments. Quotes are data; pipelines, lists, substitutions, redirects, and background jobs are syntax. |
| **Mandatory guards** | Unoverrideable protection for credentials, pipe-to-shell, privilege escalation, destructive operations, hook bypasses, and effectful options. |
| **Rules** | User and built-in rules are evaluated on each executable segment, then aggregated across the complete command. |
| **LLM review** | Called once when any segment or syntax issue needs judgment. Uses the full command, read-only filesystem tools, and conversation transcript. Fail-closed. |

On the same segment, the highest integer `priority` wins; ties use **block > review > allow**. Across segments, the complete command also aggregates as **block > review > allow**. An allow on one side of a pipe or list never authorizes another side. Mandatory guards and Tirith cannot be overridden by rule priority.

## Prerequisite: bash permission

OpenCode must allow the bash tool so commands reach this plugin. In `~/.config/opencode/opencode.json`:

```json
{
  "permission": { "bash": "allow" },
  "plugin": ["opencode-smart-approval"]
}
```

The plugin intercepts at the `tool.execute.before` hook — it only fires when OpenCode would otherwise run the command. If bash is `deny` or `ask`, the plugin never sees it.

## Install

```sh
npm install -g opencode-smart-approval
```

## Configure

The plugin loads the global config as the trusted policy boundary:

1. **Global** — `~/.config/opencode/command-approval.jsonc` (or `$XDG_CONFIG_HOME/opencode/`). Created with defaults on first run if missing.
2. **Local** — `./command-approval.jsonc` in the project directory. Ignored by default because project files may be untrusted. It only replaces the global config when the global file explicitly sets `"allow_local_config": true`.

Create the global config (JSONC — comments supported):

```jsonc
{
  "version": 2,
  "allow_local_config": false,
  "review": {
    "base_url": "https://api.openai.com/v1",
    "api_key": "sk-...",
    "model": "gpt-4o-mini",
    "timeout_ms": 45000,
    "max_script_bytes": 20000,
    "max_tool_calls": 3,
    "max_retries": 3,
    "context_messages": 20
    // "prompt": "..."  // override the default reviewer policy
  },
  "tirith": {
    "enabled": true,
    "timeout_ms": 5000,
    "fail_open": false
  },
  "rules": {
    "block": [],
    "review": [
      { "match": "^deploy(?:\\s|$).*", "scope": "segment", "priority": 50 }
    ],
    "allow": [
      {
        "match": "^my-read-only-tool(?:\\s|$).*",
        "scope": "segment",
        "priority": 100,
        "reason": "trusted personal inspection tool"
      }
    ]
  }
}
```

If the file doesn't exist, the plugin generates a default config on first run. The `review` endpoint is independent — the plugin never reads OpenCode's own model/auth config.

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `version` | `2` | Config format marker used for generated-policy migration. Only versions 1 and 2 are accepted. |
| `allow_local_config` | `false` | Allow project-local config to fully replace the global policy. Read only from the trusted global file. |
| `review.base_url` | — | OpenAI-compatible endpoint URL. **Required.** |
| `review.api_key` | — | API key. **Required.** |
| `review.model` | — | Model name. **Required.** |
| `review.timeout_ms` | `45000` | LLM review timeout (5000–300000). |
| `review.max_script_bytes` | `20000` | Max script content sent to reviewer. |
| `review.max_tool_calls` | `3` | Max read-only tool invocations per review (0–10, 0 disables tools). |
| `review.max_retries` | `3` | Max LLM API retries after the first request (integer 0–10, 0 disables retries). |
| `review.context_messages` | `20` | Recent session messages injected as transcript (0–100, 0 disables). |
| `review.prompt` | built-in | Override the reviewer policy text. See [LLM review](#llm-review). |
| `tirith.enabled` | `true` | Enable Tirith scanning. |
| `tirith.path` | auto | Local binary path. Skip auto-download. |
| `tirith.timeout_ms` | `5000` | Scanner timeout per command. |
| `tirith.fail_open` | `false` | `true` = allow on scanner failure. |
| `rules.block` | `[]` | Add configurable deny rules. Mandatory guards are separate and always active. |
| `rules.review` | `[]` | Add rules that force LLM review. |
| `rules.allow` | `[]` | Add rules that skip LLM review for a proven segment. Built-ins remain active automatically. |

## Rules

Rules are regex strings or objects with `match`, optional `reason`, `scope`, and `priority` fields. Strings and old objects remain compatible as `scope: "command"`, `priority: 0`. New pipeline-friendly rules should use `scope: "segment"`.

When loading an unversioned or version-1 config, the plugin ignores only the six exact compact-string **allow** patterns generated before v2. This prevents obsolete broad package/build/test authorization from surviving an upgrade. Custom objects and modified patterns are preserved. To intentionally restore one, set `version: 2` and rewrite it as an explicit `scope: "segment"` rule with a deliberate `priority`.

Unknown future config versions are rejected instead of being interpreted with older semantics.

```jsonc
"block": [
  // Legacy compact form: whole command, priority 0
  "^(?:printenv|set)(?:\\s|$).*",

  // Explicit form
  { "match": "^dangerous-tool(?:\\s|$).*", "scope": "segment", "priority": 100 }
],
"review": [
  { "match": "^deploy(?:\\s|$).*", "scope": "segment", "priority": 50 }
],
"allow": [
  { "match": "^my-reader(?:\\s|$).*", "scope": "segment", "priority": 100 }
]
```

**When to use each type:**

- **block** — commands you never want to run. Immediate denial, no LLM cost.
- **review** — commands that need contextual judgment (e.g. `git push`, `npm publish`). Forces LLM review with full transcript and read-only tools.
- **allow** — commands that are safe by pattern. Skips LLM review (unless Tirith warns).

`scope: "segment"` matches the exact parsed executable segment, so `my-reader | grep value` can be allowed only when both segments allow. A command-scope allow is eligible only when the command contains exactly one static executable node. Command-scope block/review rules may still escalate a compound command.

Static executable spelling is normalized before segment-rule matching. Mandatory guards also use cooked option and argument values while retaining raw spelling for expansion-sensitive checks. Prefix environment assignments, descriptor duplication, `/dev/null`, bounded input redirects, and output redirects into canonical system-temporary roots remain analyzable; sensitive redirect targets block, while output elsewhere reviews. Redirections are collected across pipelines, logical/grouped commands, and redirect-only statements. Assignments that alter executable lookup, loaders, Git/GitHub helpers, or tool configuration require review, and standalone assignments review because they change later shell state. Ambiguous word forms, dynamic command names, substitutions, heredocs, background jobs, unsupported control constructs, malformed input, and resource-limit breaches are reviewed once. Parser/runtime/asset initialization failure blocks with a fail-closed verdict.

Static nested shell bodies are still reviewed even when their inner commands are fully recoverable. Shell startup files and ambient interpreter state are outside the command AST, so auto-allowing `sh -c`/`bash -c` would not be sound without a sandbox.

## LLM review

The reviewer receives: command, cwd, tool args, matched rules, Tirith findings, script evidence, and recent conversation transcript. It returns a structured verdict (`outcome`, `risk_level`, `user_authorization`, `categories`, `reasons`).

### Read-only tools

The reviewer has two tools to verify local state before deciding:

- **`read_file`** — read file contents. The canonical target must be within cwd or a system-temporary root and must not be sensitive.
- **`list_files`** — list directory entries. Same path restriction.

Paths are canonicalized through existing parents and symlinks, then checked against canonical cwd, `tmpdir()`, `/tmp`, and `/private/tmp`. Scope escapes and sensitive credential/config paths are rejected with an error returned to the LLM. Script evidence uses the same boundary. Tool calls are capped at `max_tool_calls` per review.

### Conversation context

The plugin fetches recent messages from the current OpenCode session via the SDK client (`session.messages`), extracts text and tool-call summaries, and injects them as a transcript. This gives the reviewer user intent and authorization context — aligned with the [Codex](https://github.com/openai/codex) guardian model. Set `review.context_messages` to 0 to disable.

### Custom prompt

The default reviewer policy covers evidence handling, user authorization scoring, risk taxonomy, investigation guidelines, and outcome policy. Override it with `review.prompt` — provide the full policy text and the plugin replaces the built-in one. The JSON payload (command, rules, transcript, etc.) is always appended after your custom policy.

### Denial feedback

When the reviewer denies, `reasons` are passed back to OpenCode as a `CommandApprovalError` — the AI agent sees the denial reason and can choose a safer alternative or ask the user for explicit approval.

## Built-in rules

**Mandatory block** — credential files and sensitive globs (case-folded, canonicalized through symlinks, and recognized in Git object paths and hidden recursive searches), secret expansion (including jq `env`/`$ENV`), pipe-to-shell anywhere in a pipeline sink subtree, keychain secrets, `sudo`, environment dumps (including Apple tools such as `ipatool` that dump the process environment on startup or error paths), destructive disk/filesystem operations, git hook bypasses, destructive pushes, GitHub token/admin/auth/secret operations, and nested unattended agents. Quoted/escaped command names plus `command`, `exec`, `time`, `env`, `builtin`, and BusyBox dispatch are normalized before these guards.

**Mandatory review** — write/execute/indirect-input options such as ripgrep helpers, archive decompression and symlink following; `sort` output/temp/list inputs; checksum manifests; `file` magic/list/decompression modes; jq test/program/module files; `ffprobe` protocols and reports; time-setting `date`; strict non-display-only `sed`; effectful Git flags/subcommands and patch-producing Git views unless external diff and textconv helpers are explicitly disabled; filesystem writers and non-temporary output redirects; risky environment assignments; directory/process dispatchers; nested shell/interpreter scripts; and browser-opening GitHub flags. Protected commands that are unresolved or resolve through shell `PATH` semantics to an untrusted executable also require review. `xcrun` dispatch is trusted only when the selected tool resolves inside the active Xcode developer tree. The guard then normalizes the canonical target and Swift/Clang aliases before applying tool-family checks: host interpreters and process launchers, effectful Git, shell execution, compiler response/config/CAS/plugin/helper loading, Xcode external configuration/build-helper or risky environment overrides, and system/PATH fallback retain their own guards.

**Built-in review** — normal `git push`, package publishing, and container registry writes.

**Built-in allow** — static filters and inspectors (`grep`, `rg`, `jq`, `sort`, `cat`, strict `sed -n` display programs, etc.), shell glue including external or bare `printf` except variable-setting `-v`, filesystem/host inspection, bounded read-only Git/GitHub commands, and selected macOS diagnostics. Safe Git global options may precede a read-only subcommand. File-reader operands, auxiliary inputs, active globs, and tilde expansion are command-aware and must remain inside the current working directory or system temporary directory; symlink escapes and external paths require review. Directory operands to ripgrep are scanned recursively with a fixed bound before an allow decision: normal searches inspect visible descendants, while `--hidden`/unrestricted forms also inspect hidden descendants.

Project code execution (package scripts, tests, builds, interpreters), filesystem writes, and iOS development tools are not generically allowed because OpenCode has no sandbox. Put intentionally trusted project- or user-specific commands in explicit segment rules. Those rules can override ordinary same-segment policy, but never mandatory guards or sibling decisions.

A user may therefore allow iOS CLIs such as `xcodebuild`, `xcodebuildmcp`, `sim-use`, `asc`, or `xcrun` as whole command families. Normal Apple SDK selectors, the default Xcode toolchain, tools resolved inside the selected Xcode developer tree, known Swift Package subcommands, non-executing Swift query/typecheck modes, and device-side `simctl`/`devicectl` can use that allow rule. Custom SDK/toolchain selectors or `SDKROOT`/`TOOLCHAINS`, Swift scripts/REPLs/dynamic plugin commands, compiler response/config/CAS/plugin helpers, App Intents metadata toolchain overrides, `xctrace --launch`, host-side launchers and interpreters, Xcode xcconfig or compiler/linker/environment overrides (including helper-bearing `OTHER_*FLAGS`), effectful Git, unsafe environment changes, and tools resolved outside the selected developer tree still review or block.

## Tirith

[Tirith](https://github.com/sheeki03/tirith) is a terminal security scanner in Rust. It catches what regex cannot: Cyrillic homograph URLs, ANSI escape injection, base64 decode-execute chains, credential exfiltration via `curl` uploads, obfuscated piped payloads, invisible Unicode steganography. Sub-millisecond overhead on clean input.

### Auto-download

If `tirith.path` is not set, the plugin downloads the latest release for your platform on first use, verifies the upstream SHA-256, and caches the binary with release, archive-digest, binary-digest, and freshness metadata. Cache reuse verifies the binary locally and refreshes upstream release/checksum metadata after 24 hours; a new release or digest installs atomically. HTTP bodies, redirects, total time, archive size, entry bounds, inflated archive size, and extracted binary size are bounded. Unsupported or missing release assets are treated according to `tirith.fail_open`, just like scanner execution failures.

| Platform | Supported |
|----------|-----------|
| macOS arm64 / x64 | ✅ |
| Linux glibc arm64 / x64 | ✅ |
| Linux musl arm64 | ✅ |
| Windows x64 | ✅ |

## Privacy

- Reviewer sees: command, cwd, tool args, matched rules, Tirith findings, referenced script content, recent session transcript.
- Read-only tools and script evidence are canonicalized and scoped to cwd plus system-temporary roots; sensitive paths and symlink escapes are rejected.
- The plugin does not create OpenCode sessions or call `opencode run`.

## Development

```sh
cd opencode-smart-approval
bun install
bun run typecheck
bun test
```

## References

- [OpenCode](https://github.com/sst/opencode) — the open-source coding agent this plugin extends. Provides the `tool.execute.before` hook and `permission` model that makes command interception possible without core changes.
- [OpenGuardrails Instrumentation for OpenCode](https://github.com/openguardrails/openguardrails-instrumentation-opencode) — a complementary guardrails plugin using the OGR protocol. Similar `tool.execute.before` instrumentation pattern with text/regex rules and optional LLM judge; this project takes a different approach with Tirith integration and a staged parser-and-policy pipeline.
- [OpenAI Codex CLI](https://github.com/openai/codex) — OpenAI's terminal coding agent. Its sandbox-and-auto-approve model inspired the fail-closed default, read-only tool design, and evidence-based approval with conversation context.
- [Dyad](https://github.com/dyad-sh/dyad) — a local open-source AI app builder. Its permission hooks and policy configuration patterns informed the JSONC config design and the separation between deterministic rules and contextual review.
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) — a self-improving AI agent by Nous Research. Its built-in Tirith integration with auto-install, checksum verification, and circuit-breaker fail-open logic directly inspired this plugin's Tirith auto-download and fail-closed behavior.
- [Tirith](https://github.com/sheeki03/tirith) — the terminal security scanner used as the first stage of this pipeline. Intercepts homograph URLs, pipe-to-shell, ANSI injection, obfuscated payloads, credential exfiltration, and malicious AI skills before execution.

## License

MIT
