# opencode-smart-approval

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A plugin for [OpenCode](https://github.com/sst/opencode) that automatically approves shell commands through three layers: regex rules, [Tirith](https://github.com/sheeki03/tirith) security scanning, and LLM agent review with read-only tools.

## How it works

Every shell command (`bash`, `shell`, `exec_command`, etc.) goes through a four-stage pipeline:

```
Command → ① Tirith scan → ② User rules → ③ Built-in rules → ④ LLM review → Verdict
```

| Stage | Priority | Action |
|-------|----------|--------|
| **Tirith** | 1st | Content-level threat scanner (homograph URLs, pipe-to-shell, obfuscated payloads, credential exfiltration, ANSI injection). Can block or escalate to LLM. |
| **User rules** | 2nd | `block` / `review` / `allow` regex rules from `command-approval.jsonc`. Override built-in rules for matching commands. |
| **Built-in rules** | 3rd | Ship with the plugin. Active when no user rule matches. |
| **LLM review** | 4th | OpenAI-compatible endpoint via Vercel AI SDK. Called when prior stages are undecided. Has read-only filesystem tools and conversation transcript. Fail-closed. |

Decision precedence within rule matching: **block > review > allow**. A `block` rule stops matching immediately. A `review` rule forces LLM review even if a later `allow` rule would match. Tirith `warn` forces LLM review even when an `allow` rule matched.

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

Create `~/.config/opencode/command-approval.jsonc` (JSONC — comments supported):

```jsonc
{
  "review": {
    "base_url": "https://api.openai.com/v1",
    "api_key": "sk-...",
    "model": "gpt-4o-mini",
    "timeout_ms": 45000,
    "max_script_bytes": 20000,
    "max_tool_calls": 3,
    "context_messages": 20
    // "prompt": "..."  // override the default reviewer policy
  },
  "tirith": {
    "enabled": true,
    "timeout_ms": 5000,
    "fail_open": false
  },
  "rules": {
    "block": [
      { "match": "git\\b.*--no-verify\\b", "reason": "bypasses git hooks" }
    ],
    "review": [
      "git\\s+push\\b(?!.*(?:--force|-f\\s|:)).*"
    ],
    "allow": [
      "^(?:pwd|ls|rg)(?:\\s|$).*"
    ]
  }
}
```

If the file doesn't exist, the plugin generates a default config on first run. The `review` endpoint is independent — the plugin never reads OpenCode's own model/auth config.

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `review.base_url` | — | OpenAI-compatible endpoint URL. **Required.** |
| `review.api_key` | — | API key. **Required.** |
| `review.model` | — | Model name. **Required.** |
| `review.timeout_ms` | `45000` | LLM review timeout (5000–300000). |
| `review.max_script_bytes` | `20000` | Max script content sent to reviewer. |
| `review.max_tool_calls` | `3` | Max read-only tool invocations per review (0–10, 0 disables tools). |
| `review.context_messages` | `20` | Recent session messages injected as transcript (0–100, 0 disables). |
| `review.prompt` | built-in | Override the reviewer policy text. See [LLM review](#llm-review). |
| `tirith.enabled` | `true` | Enable Tirith scanning. |
| `tirith.path` | auto | Local binary path. Skip auto-download. |
| `tirith.timeout_ms` | `5000` | Scanner timeout per command. |
| `tirith.fail_open` | `false` | `true` = allow on scanner failure. |
| `rules.block` | built-in | Deny matching commands immediately. |
| `rules.review` | built-in | Force LLM review for matching commands. |
| `rules.allow` | built-in | Skip LLM review for matching commands. |

## Rules

Rules are regex strings (compact form) or `{ "match": "...", "reason": "..." }` objects. The `reason` field is passed back to OpenCode as the tool error message when a `block` rule fires — the AI agent sees why and can choose a safer alternative.

```jsonc
"block": [
  // compact — regex string only
  "^(?:printenv|set)(?:\\s|$).*",

  // with reason — surfaced to the AI agent on denial
  { "match": "git\\b.*--no-verify\\b", "reason": "bypasses git hooks and safety checks" }
],
"review": [
  // matching these forces LLM review, even if an allow rule also matches
  "(?:^|[;&|]\\s*)(?:npm|pnpm|yarn)\\s+publish\\b.*"
],
"allow": [
  "^(?:pwd|ls|rg)(?:\\s|$).*"
]
```

**When to use each type:**

- **block** — commands you never want to run. Immediate denial, no LLM cost.
- **review** — commands that need contextual judgment (e.g. `git push`, `npm publish`). Forces LLM review with full transcript and read-only tools.
- **allow** — commands that are safe by pattern. Skips LLM review (unless Tirith warns).

## LLM review

The reviewer receives: command, cwd, tool args, matched rules, Tirith findings, script evidence, and recent conversation transcript. It returns a structured verdict (`outcome`, `risk_level`, `user_authorization`, `categories`, `reasons`).

### Read-only tools

The reviewer has two tools to verify local state before deciding:

- **`read_file`** — read file contents. Path must be within cwd or system tmp.
- **`list_files`** — list directory entries. Same path restriction.

Paths are resolved and checked against `resolve(cwd)` and `resolve(tmpdir())`. Anything outside is rejected with an error message returned to the LLM. Tool calls are capped at `max_tool_calls` per review.

### Conversation context

The plugin fetches recent messages from the current OpenCode session via the SDK client (`session.messages`), extracts text and tool-call summaries, and injects them as a transcript. This gives the reviewer user intent and authorization context — aligned with the [Codex](https://github.com/openai/codex) guardian model. Set `review.context_messages` to 0 to disable.

### Custom prompt

The default reviewer policy covers evidence handling, user authorization scoring, risk taxonomy, investigation guidelines, and outcome policy. Override it with `review.prompt` — provide the full policy text and the plugin replaces the built-in one. The JSON payload (command, rules, transcript, etc.) is always appended after your custom policy.

### Denial feedback

When the reviewer denies, `reasons` are passed back to OpenCode as a `CommandApprovalError` — the AI agent sees the denial reason and can choose a safer alternative or ask the user for explicit approval.

## Built-in rules

**Block** — credential files, env secrets, keychain reads, `sudo`, privilege escalation, environment dumps, destructive `rm -rf`, disk/device ops, git hook bypasses, force pushes, nested agent calls.

**Review** — `git push` (non-force), `npm/pnpm/yarn publish`, `docker/podman push`.

**Allow** — read-only commands (`ls`, `pwd`, `rg`, `cat`, etc.), version/help flags, read-only git operations, test/build/lint runners, safe macOS tools, basic file ops (`mkdir`, `touch`, `cp`).

Built-in rules apply when no user rule matches. User rules take precedence for the commands they match.

## Tirith

[Tirith](https://github.com/sheeki03/tirith) is a terminal security scanner in Rust. It catches what regex cannot: Cyrillic homograph URLs, ANSI escape injection, base64 decode-execute chains, credential exfiltration via `curl` uploads, obfuscated piped payloads, invisible Unicode steganography. Sub-millisecond overhead on clean input.

### Auto-download

If `tirith.path` is not set, the plugin downloads the latest release for your platform on first use, verifies SHA-256, and caches the binary:

| Platform | Supported |
|----------|-----------|
| macOS arm64 / x64 | ✅ |
| Linux glibc arm64 / x64 | ✅ |
| Linux musl arm64 | ✅ |
| Windows x64 | ✅ |

## Privacy

- Reviewer sees: command, cwd, tool args, matched rules, Tirith findings, referenced script content, recent session transcript.
- Read-only tools are scoped to cwd and system tmp — no access outside.
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
- [OpenGuardrails Instrumentation for OpenCode](https://github.com/openguardrails/openguardrails-instrumentation-opencode) — a complementary guardrails plugin using the OGR protocol. Similar `tool.execute.before` instrumentation pattern with text/regex rules and optional LLM judge; this project takes a different approach with Tirith integration and a dedicated four-stage pipeline.
- [OpenAI Codex CLI](https://github.com/openai/codex) — OpenAI's terminal coding agent. Its sandbox-and-auto-approve model inspired the fail-closed default, read-only tool design, and evidence-based approval with conversation context.
- [Dyad](https://github.com/dyad-sh/dyad) — a local open-source AI app builder. Its permission hooks and policy configuration patterns informed the JSONC config design and the separation between deterministic rules and contextual review.
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) — a self-improving AI agent by Nous Research. Its built-in Tirith integration with auto-install, checksum verification, and circuit-breaker fail-open logic directly inspired this plugin's Tirith auto-download and fail-closed behavior.
- [Tirith](https://github.com/sheeki03/tirith) — the terminal security scanner used as the first stage of this pipeline. Intercepts homograph URLs, pipe-to-shell, ANSI injection, obfuscated payloads, credential exfiltration, and malicious AI skills before execution.

## License

MIT