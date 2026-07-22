# opencode-smart-approval

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[中文](README.zh-CN.md)

An [OpenCode](https://github.com/sst/opencode) command-approval plugin that combines strict personal rules, Tree-sitter shell analysis, [Tirith](https://github.com/sheeki03/tirith), and a restricted direct OpenCode approval agent.

This is an application-level approval boundary, not a command sandbox. OpenCode, the selected model/provider, and every co-loaded plugin remain part of the trusted computing base. The plugin reduces accidental approval and supplies fail-closed evidence handling; it does not provide operating-system filesystem or network isolation.

## Requirements and installation

The production contract is pinned to `@opencode-ai/plugin` and its root client at OpenCode `1.17.14`.

```sh
npm install -g opencode-smart-approval
```

OpenCode must allow the shell tool so `tool.execute.before` can inspect it. Provider credentials and models stay in the user's OpenCode configuration, for example:

```text
{
  "permission": { "bash": "allow" },
  "plugin": ["opencode-smart-approval"],
  "small_model": "provider/reviewer-model"
}
```

If OpenCode denies or asks for `bash` before execution, this plugin does not receive the tool call. The optional `small_model` participates in the model precedence described below.

## Decision pipeline

Every supported shell call follows one shared analysis and one loaded policy snapshot:

```text
Configuration-access guard → User rules → Built-in rules → Tirith → Direct OpenCode approval agent
```

| Stage | Behavior |
|---|---|
| Configuration-access guard | Proven writes to the active approval policy are blocked. Ambiguous policy-capable writes cannot take an allow shortcut and continue through review. |
| User rules | A complete explicit deny is terminal. A complete explicit allow is terminal unless the configuration-access guard forced review. Partial, unmatched, or explicit review results continue. |
| Built-in rules | A deliberately small platform-neutral fast path for basic shell glue and inspection. |
| Tirith | Scans the complete unsplit command. A block is terminal; allow or warn proceeds with scanner evidence. |
| Approval agent | Creates a restricted OpenCode child session, validates its final runtime identity, submits bounded evidence, parses one strict verdict, and fails closed. |

For a pipeline or list, every statically parsed executable segment must be allowed before an allow can short-circuit. A deny on any segment denies the whole command. Same-priority rule conflicts resolve as `deny > review > allow`; higher integer `priority` wins first.

## Direct OpenCode client architecture

Production reuses the exact root `PluginInput.client` supplied to the plugin. It does not import the SDK `/v2` client, construct another OpenCode client or server, invoke `opencode run`, or start a child OpenCode process. Each pinned root method receives one generated options object with `path`, `query`, `body`, and `signal` at the levels declared by OpenCode 1.17.14. The plugin captures these methods once and uses:

- `app.agents` and sanitized `app.log`;
- `session.messages`, `session.create`, `session.prompt`, `session.abort`, and `session.delete`.

The reviewer does create a child session inside the already-running OpenCode instance. That corrects the previous “no sessions” claim: no extra OpenCode process is started, but review sessions are stored by the host until the lifecycle policy deletes them or the user explicitly retains them.

The generated 1.17.14 declarations and runtime transport do not fully agree. Generated declarations expose legacy agent fields such as `builtIn`, `tools`, `maxSteps`, and an older permission shape, while the observed `app.agents` runtime exposes `native`, `steps`, normalized permission rules, and nullable `hidden`, `topP`, `color`, and `variant` fields. Runtime message data also contains source fields that lag declarations. Client responses are therefore treated as unknown and parsed through strict source-locked schemas; unknown fields, wrong nullability, duplicate fixed agents, or identity drift fail closed.

## Policy version 3

The trusted global policy is `~/.config/opencode/command-approval.jsonc`, or `$XDG_CONFIG_HOME/opencode/command-approval.jsonc`. It is created with v3 defaults when absent.

A project may provide `./command-approval.jsonc`, but it is ignored unless the trusted global file sets `"allow_local_config": true`. When enabled, the local file completely replaces the global policy for that project. Treat an opted-in project policy as trusted code.

The minimal valid policy is:

```jsonc policy-v3
{
  "version": 3,
  "review": {}
}
```

Version 3 is intentionally strict. Every top-level, `review`, `self_protection`, `tirith`, `rules`, and rule object rejects unknown fields. String shorthand, aliases, unversioned/v1/v2 documents, and the legacy `command-approval.json` filename are rejected without compatibility fallback or automatic replacement.

### Policy options

| Option | Default and contract |
|---|---|
| `version` | Required literal `3`. |
| `allow_local_config` | `false`; read only from the trusted global file. |
| `self_protection.enabled` | `true`; enables the best-effort configuration-access guard. |
| `review.model` | Absent; when present, an exactly trimmed `provider/model` identity. The model part may contain later slashes. |
| `review.timeout_ms` | `45000`; safe integer from `1000` through `300000`. |
| `review.context_messages` | `20`; safe integer from `0` through `200`; `0` disables reviewer transcript context. |
| `review.prompt` | Absent; exactly trimmed nonempty trusted-policy suffix, at most 8,192 UTF-16 code units. It is appended after the invariant security contract and cannot replace it. |
| `review.cleanup_session` | `true`; delete an ordinarily completed review child by exact ID. |
| `tirith.enabled` | `true`. |
| `tirith.path` | Absent; an exactly trimmed absolute local binary path skips auto-download. |
| `tirith.timeout_ms` | `5000`; safe integer from `500` through `60000`. |
| `tirith.fail_open` | `false`. |
| `rules.deny`, `rules.review`, `rules.allow` | Empty user lists, followed by the small built-in rule set. |

Each rule is a strict object containing required nonempty `match` and optional nonempty `reason`, `scope: "command" | "segment"`, and safe-integer `priority`. Use segment scope for executable-specific trust. Command-scope allow is eligible only when analysis finds exactly one static executable node.

### Model precedence

The fixed approval agent selects its model in this exact order:

1. valid `review.model` in the approval policy;
2. OpenCode `small_model` from `opencode.json` or `opencode.jsonc`;
3. omit the agent `model` property and let OpenCode inherit its configured selection.

A present invalid policy model fails policy loading. It never falls back to `small_model`.

## Breaking migration from v1/v2

Migration is manual because configuration compatibility is deliberately removed:

1. Keep provider URLs, API keys, provider plugins, and provider model definitions in OpenCode's own configuration.
2. Create `command-approval.jsonc` with required `version: 3` and required `review: {}`. Do not reuse the legacy `.json` filename.
3. Copy personal rules into strict object entries under `rules.deny`, `rules.review`, and `rules.allow`.
4. Add only current v3 review, Tirith, local-policy, or guard options from the table above.
5. Start OpenCode and fix the exact reported field category; the loader does not guess at old semantics.

This removed shape is an example of what must not be copied. The strict loader rejects it at category `version` before using any retired key:

```jsonc removed-v2 version
{
  "version": 2,
  "review": {
    "base_url": "https://api.example.invalid/v1",
    "api_key": "removed",
    "max_script_bytes": 20000,
    "max_tool_calls": 3,
    "max_retries": 3
  }
}
```

Removed identifiers include `base_url`, `api_key`, `max_script_bytes`, `max_tool_calls`, `max_retries`, `rules.block`, `risk_tool`, camelCase aliases, string rule shorthand, and version 1/2 migration behavior. Provider transport and authentication now belong solely to OpenCode; reviewer bounds and tools are fixed by the plugin rather than policy-controlled.

## Fixed restricted approval agent

The configuration hook replaces the fixed name `opencode-smart-approval-reviewer` at its point in plugin order while preserving unrelated agents. The authored config is frozen independently and contains:

- fixed description `Reviews one shell command for opencode-smart-approval using only the plugin-owned guarded reader.` and invariant security contract;
- `mode: "subagent"`, `steps: 4`, and `temperature: 0`;
- the selected optional model;
- permission map `{"*":"deny","external_directory":"deny","opencode_smart_approval_read":"allow"}`.

Immediately before creation and again before prompting, `app.agents` must expose exactly one matching agent with the fixed description, prompt, mode, steps, temperature, model, empty options, `native: false`, no enabled optional override, and the exact final normalized permission suffix:

| Permission | Pattern | Action |
|---|---|---|
| `*` | `*` | `deny` |
| `external_directory` | `*` | `deny` |
| `opencode_smart_approval_read` | `*` | `allow` |

OpenCode may append exactly one host-owned allow for its derived `.../opencode/tool-output/*` directory. Any other later permission rule fails validation. Every `session.prompt` also sends the exact tool map `{"*":false,"opencode_smart_approval_read":true}`.

The approval agent has no shell, network, general read/list, write/edit, question, or permission-management tool granted by this plugin. This is an OpenCode tool-dispatch restriction, not OS sandboxing.

## Guarded reader boundary

The only plugin-owned reviewer tool is `opencode_smart_approval_read` with strict arguments `path` and optional nonnegative safe-integer `offset` (default `0`). One call returns at most 65,536 bytes.

Access requires the current owned child-session ID, fixed agent name, canonical review directory, matching worktree, live generation, and non-aborted prompt. Ownership is revoked before cleanup.

- Workspace files are opened on demand beneath the anchored workspace root.
- Outside that workspace, only exact existing files statically referenced by the shared shell analysis beneath the canonical temporary root or distinct worktree are leased. The agent cannot browse an entire temporary directory.
- Every component is traversed by anchored descriptors. The final target must be a regular single-link file; symlinks, hard links, special files, traversal, malformed paths, and scope escapes fail closed.
- Temporary references retain the exact descriptor snapshot opened at activation. Workspace reads compare the descriptor before and after the bounded read. Revocation, replacement, or identity change cannot switch the bytes being authorized.

The authoritative POSIX sensitive-path predicate is case-insensitive and rejects any `/`- or `=`-separated component equal to `.env`, `.env.local`, `.git`, `.git-credentials`, `.netrc`, `.npmrc`, `.pypirc`, `.ssh`, `.aws`, `.docker`, `.kube`, `.azure`, or `auth.json`; every component starting `.env.`; `.config/gh` and `.config/gcloud`; and exact `/proc/self/environ`, `/proc/thread-self/environ`, or numeric process/task `environ` paths. Backslash remains an ordinary POSIX character. This predicate is applied to the requested, root-relative, and absolute spellings before descriptor traversal.

## Context and authorization boundary

The reviewer can see bounded evidence: command, canonical cwd, tool arguments, shell analysis, matched rules, Tirith result, static references, and a projected parent transcript. Policy `context_messages` caps the requested message count; independent limits cap the copied envelope, per-part and total text, parts, tool names, and the complete serialized review request. Synthetic/ignored text, attachments, summaries, unsupported parts, malformed identity/order, and raw confirmation phrases are excluded or fail closed.

Transcript text is evidence, not plugin authorization. A user may express intent there and the reviewer may independently judge an action safe, but quoted commands, assistant prose, old approvals, generic “continue” text, and every pre-challenge statement never become a plugin confirmation. Only the plugin-generated `authorization_proof` below authorizes the confirmation route.

## One-shot informed confirmation

When the reviewer returns `needs_confirmation`, it must supply concrete `action`, `data`, `destination`, and `risk`. The plugin blocks the first attempt and renders those four fields plus the complete command and canonical cwd, effect and disclosure SHA-256 values, replacement state, a 300-second scope, and this exact-form phrase:

`AUTHORIZE opencode-smart-approval <43-character-base64url-nonce>`

Confirmation requires exactly one new ordinary parent-session user message after the stored boundary, containing exactly that phrase. There is no trimming, case folding, Unicode normalization, extra text, assistant/synthetic/summary substitution, or ambiguity allowance. The challenge is bound to the parent session, boundary tuple, canonical cwd, command-effect hash, disclosure hash, generation, and expiry.

The nonce is one-shot. A successful match atomically consumes it; replay, mismatch, expiry, a changed effect, a replaced/evicted boundary, or multiple newer messages fails closed. An automatic retry before a user response remains awaiting without rotating the challenge. A matching retry does not directly allow execution: it reruns Tirith and the approval agent with a hash-only proof, and that second review must independently allow.

The plaintext nonce necessarily appears in the parent-facing error and in the user's response, so it may remain in OpenCode's parent transcript or host storage. Plugin state stores only SHA-256 token hashes. It retains at most 64 active/recent hashes per parent session for up to 24 hours solely to redact full phrases and embedded token copies from reviewer payloads; session deletion or plugin disposal clears them.

Pinned OpenCode 1.17.14 can originate a custom permission through `ToolContext.ask`, but its custom-permission UI hides supplied risk metadata behind a generic tool call and offers `Always allow` even with no useful permanent pattern. The `permission.ask` plugin hook observes a request; it does not provide this plugin's complete disclosure protocol. This plugin therefore does not use native custom permission, question, dynamic permission names, or permission replies as informed consent.

## User-facing error safety

Untrusted tool names, rule/scanner/provider/reviewer reasons, paths, and confirmation fields pass through one renderer. It escapes backslash, quotes, backticks, control characters, bidi controls, and BOM; invalid UTF-16 is replaced safely for ordinary errors and rejects confirmation rendering.

Ordinary block errors cap the escaped tool at 1,024 bytes, each reason at 1,024 bytes, reasons at 16, categories at 32, aggregate reason text at 8,192 bytes, and the body at 16,384 bytes. Confirmation never truncates individual disclosure fields: the escaped command is capped at 8,192 bytes and the complete body at 16,384 bytes, otherwise the confirmation attempt fails closed.

## Review-session lifecycle

After preflight succeeds, at most one exact child is created per review and tracked by ID, directory, fixed agent type, prompt settlement, and reader lease. Cleanup operations share one idempotent promise, so idle, deleted, instance-disposed, hook-disposed, timeout, and late-settlement paths cannot delete a foreign session or issue duplicate deletion.

With default `review.cleanup_session: true`, ordinary success revokes the reader lease and deletes the exact child. Abnormal completion revokes access, conditionally aborts an unsettled prompt, drains it within a bound, and attempts exact deletion even when cleanup is disabled. A matching external `session.deleted` event is accepted as already deleted.

With `cleanup_session: false`, only a fully settled ordinary review may remain as an inactive retained session: its reader lease is revoked and no adapter promise or tool call remains. Retained sessions stay in OpenCode's database until the user or a later harness removes them. Disposal does not reinterpret an already retained success, but it cleans any still-active owned review.

## Tirith integrity and offline behavior

If `tirith.path` is present, it must be an absolute path. If it is absent, the plugin selects the platform asset, downloads bounded release/checksum/archive data, verifies the upstream archive SHA-256, extracts within strict entry/size limits, records the binary digest, and installs atomically in its cache.

A cache younger than 24 hours is reused only when metadata and current binary digest match. When refresh is unavailable, an aged cache may be returned explicitly as `stale_verified` only after re-reading metadata and re-verifying the exact binary, asset, release, archive digest, and binary digest proof. Malformed upstream data, a changed/revoked release, absent proof, or tampered bytes do not use stale fallback. Scanner execution failure follows trusted `tirith.fail_open`; the default is fail closed.

## Configuration-access guard limitations

`self_protection.enabled` controls a best-effort pre-execution guard for the currently reload-effective global policy and, only when opted in, its local policy. It blocks proven shell redirections/writers and recognized OpenCode `write`, `edit`, and patch targets. Static ambiguity forces the post-deny review path, so a broad allow cannot silently bypass it; proven observers and adjacent/inactive files are not falsely blocked.

This guard is not a filesystem ACL. It cannot prevent manual edits, other processes, host/core changes, unobserved co-plugin behavior, or every time-of-check/time-of-use race. Unknown file tools and dynamic effects may be invisible or only force review. Disable it only in the trusted global policy when another control owns the risk.

## Host, plugin, and sandbox trust

OpenCode 1.17.14 loads plugins process-wide; it has no per-review-child plugin toggle. This plugin never mutates `OPENCODE_DISABLE_DEFAULT_PLUGINS` or `OPENCODE_PURE`:

- enabling `OPENCODE_DISABLE_DEFAULT_PLUGINS` after startup cannot change one child, and setting it at boot also removes built-in provider integrations required by configured models;
- `OPENCODE_PURE` removes external plugins, including this approval plugin;
- leaving both untouched keeps the user's OpenCode/provider plugin configuration authoritative and available.

There is no product `pure` option. Only the later package-excluded Todo 12 verification harness owns an isolated boot-only disable-default-plugins probe; production does not copy that environment.

The config hook overwrites a same-name agent at its point in load order, and runtime field/permission validation detects later agent mutation. However `app.agents` exposes neither the effective enabled-tool map nor tool-definition provenance. OpenCode may retain duplicate same-name tool definitions, and later session assembly can select a later co-plugin definition. A malicious or incompatible co-plugin can therefore replace the guarded reader implementation or mutate host behavior. Review the complete plugin list and treat co-plugins and OpenCode itself as trusted.

The fixed permission/tool maps restrict OpenCode dispatch but do not isolate provider code, plugins, the host process, filesystem syscalls, or network access. A broader network-enabled OS sandbox for approval-agent inspection remains deferred because OpenCode config/data/cache/state/provider access requires a separate design.

## Privacy summary

- The selected provider sees the bounded review request and the model's interaction with the one guarded reader.
- The approval child lives in the existing OpenCode process/database and is deleted by exact ID by default.
- Parent confirmation plaintext can persist in the parent transcript; reviewer copies are redacted using hash-only history.
- Tirith auto-download and model/provider traffic follow their configured network paths.
- The plugin does not start `opencode run`, construct a second client/server, or change provider/plugin environment flags.

## Development

```sh
bun install
bun run typecheck
bun test
```

## References

- [OpenCode](https://github.com/sst/opencode)
- [Tirith](https://github.com/sheeki03/tirith)
- [OpenGuardrails Instrumentation for OpenCode](https://github.com/openguardrails/openguardrails-instrumentation-opencode)
- [OpenAI Codex CLI](https://github.com/openai/codex)

## License

MIT
