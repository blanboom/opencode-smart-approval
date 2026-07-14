# opencode-smart-approval

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A plugin for [OpenCode](https://github.com/sst/opencode) that safely reduces shell-command approval cost with [Tirith](https://github.com/sheeki03/tirith), Tree-sitter shell analysis, deterministic rules, and an LLM reviewer with read-only tools.

OpenCode does not provide a command sandbox. This plugin keeps personal trust decisions explicit, uses only a small generic built-in fast path, and delegates risk detection to Tirith before contextual LLM review.

## How it works

Every shell command (`bash`, `shell`, `exec_command`, etc.) follows this pipeline:

```
Configuration self-protection → User rules → Built-in rules → Tirith → LLM
```

| Stage | Action |
|-------|--------|
| **Configuration self-protection** | Before normal approval, rejects shell writes and OpenCode `Write`/`Edit`/`apply_patch` edits to active global or project policy files. Enabled by default and configurable. |
| **User rules** | Highest priority. A complete allow or deny is terminal and skips all later stages. Tree-sitter extracts static executable segments so one side of a pipeline cannot authorize another. |
| **Built-in rules** | A deliberately small allow/deny fast path for common low-risk commands. It contains no platform-specific risk catalog. |
| **Tirith** | Scans the complete, unsplit raw command when deterministic rules do not decide it. A block is final; allow/warn results continue to the LLM, with warnings attached as evidence. |
| **LLM review** | Final contextual judgment using the full command, scanner findings, read-only filesystem tools, and conversation transcript. Fail-closed. |

Within the user-rule stage, the highest integer `priority` wins on the same segment; ties use **deny > review > allow**. Across segments, the complete command aggregates with the same order. A pipeline or list short-circuits only when every static executable segment is allowed. A user deny on any segment denies the whole command; a partial allow, unmatched command, or explicit review continues to Tirith and then the LLM.

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
  "self_protection": { "enabled": true },
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
    "deny": [],
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
| `self_protection.enabled` | `true` | Reject shell and OpenCode file-tool edits to active approval config files. Dynamic shell output paths fail closed because the target cannot be proven safe. Set `false` in the trusted policy to disable. |
| `review.base_url` | — | OpenAI-compatible endpoint URL. **Required.** |
| `review.api_key` | — | API key. **Required.** |
| `review.model` | — | Model name. **Required.** |
| `review.timeout_ms` | `45000` | LLM review timeout (5000–300000). |
| `review.max_script_bytes` | `20000` | Max script content sent to reviewer. |
| `review.max_tool_calls` | `3` | Max read-only tool invocations per review (0–10, 0 disables tools). |
| `review.max_retries` | `3` | Max LLM API transport retries per request (integer 0–10). A positive value also permits one fresh request after malformed structured output; 0 disables both. |
| `review.context_messages` | `20` | Recent session messages injected as transcript (0–100, 0 disables). |
| `review.prompt` | built-in | Override the reviewer policy text. See [LLM review](#llm-review). |
| `tirith.enabled` | `true` | Enable Tirith scanning. |
| `tirith.path` | auto | Local binary path. Skip auto-download. |
| `tirith.timeout_ms` | `5000` | Scanner timeout per command. |
| `tirith.fail_open` | `false` | `true` = allow on scanner failure. |
| `rules.deny` | `[]` | User deny rules. Terminal before built-ins, Tirith, and the LLM. |
| `rules.block` | `[]` | Legacy alias for `rules.deny`; retained for existing configs. |
| `rules.review` | `[]` | User rules that require the scanner and final LLM judgment. |
| `rules.allow` | `[]` | User allow rules. A complete match is terminal and skips built-ins, Tirith, and the LLM. |

## Rules

Rules are regex strings or objects with `match`, optional `reason`, `scope`, and `priority` fields. Strings and old objects remain compatible as `scope: "command"`, `priority: 0`. New pipeline-friendly rules should use `scope: "segment"`.

When loading an unversioned or version-1 config, the plugin ignores only the six exact compact-string **allow** patterns generated before v2. This prevents obsolete broad package/build/test authorization from surviving an upgrade. Custom objects and modified patterns are preserved. To intentionally restore one, set `version: 2` and rewrite it as an explicit `scope: "segment"` rule with a deliberate `priority`.

Unknown future config versions are rejected instead of being interpreted with older semantics.

```jsonc
"deny": [
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

- **deny** — commands you never want to run. Immediate denial with no scanner or LLM cost. `block` remains a compatibility alias.
- **review** — commands that need contextual judgment. They continue through Tirith and then the LLM.
- **allow** — commands you explicitly trust by pattern. A complete match skips every later stage.

`scope: "segment"` matches the exact parsed executable segment, so `my-reader | grep value` can be allowed only when both segments allow. A command-scope allow is eligible only when the command contains exactly one static executable node. Command-scope block/review rules may still escalate a compound command.

Static executable spelling is normalized before segment-rule matching. Quotes remain literal data; pipelines and lists are split into executable segments; nested static shell bodies are analyzed recursively. Redirections, substitutions, background execution, unsupported control structures, malformed input, and resource-limit breaches prevent a built-in allow from short-circuiting. Parser/runtime/asset initialization failure blocks fail-closed.

User rules remain authoritative for the complete static command. For pipelines and lists, every executable sibling must be explicitly user-allowed before later stages are skipped.

## LLM review

The reviewer receives: command, cwd, tool args, matched rules, Tirith findings, script evidence, and recent conversation transcript. It returns a structured verdict (`outcome`, `risk_level`, `user_authorization`, `categories`, `reasons`).

Malformed or schema-invalid structured output gets one fresh format-correction request when retries are enabled. A second invalid response, or an invalid first response when retries are disabled, fails closed.

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

Built-ins are intentionally narrow and platform-neutral:

- **Allow:** basic shell glue (`echo`, `printf`, `true`, `false`, `test`), basic location/directory inspection (`ls`, `pwd`, `basename`, `dirname`), and `command -v`.
- **Deny:** currently empty. Risk classification belongs to Tirith rather than a duplicated regex catalog.

Built-in allows never cover output redirection, and compound commands still require every executable segment to match. Commands such as `git push`, package publishing, project builds, interpreters, filesystem writers, and platform-specific developer tools remain unmatched and proceed to Tirith plus LLM review unless the user adds an explicit rule.

## Tirith

[Tirith](https://github.com/sheeki03/tirith) is a terminal security scanner in Rust. It catches what a small built-in rule set should not duplicate: Cyrillic homograph URLs, ANSI escape injection, base64 decode-execute chains, credential exfiltration via `curl` uploads, obfuscated piped payloads, and invisible Unicode steganography.

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
- [Tirith](https://github.com/sheeki03/tirith) — the terminal security scanner used after deterministic user and built-in rules. Intercepts homograph URLs, pipe-to-shell, ANSI injection, obfuscated payloads, credential exfiltration, and malicious AI skills before execution.

## License

MIT
