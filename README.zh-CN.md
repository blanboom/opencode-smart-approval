# opencode-smart-approval

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[English](README.md)

一个 [OpenCode](https://github.com/sst/opencode) 命令审批插件，组合严格的个人规则、Tree-sitter Shell 分析、[Tirith](https://github.com/sheeki03/tirith) 与受限的 OpenCode 直接审批 Agent。

这是应用层审批边界，不是命令沙盒。OpenCode、所选模型/Provider 以及所有同时加载的插件仍属于可信计算基。本插件用于减少误审批并对证据实行失败封闭处理；它不提供操作系统级文件系统或网络隔离。

## 要求与安装

生产契约固定在 OpenCode `1.17.14` 的 `@opencode-ai/plugin` 及其根客户端。

```sh
npm install -g opencode-smart-approval
```

OpenCode 必须允许 Shell 工具，`tool.execute.before` 才能检查它。Provider 凭证与模型继续保存在用户的 OpenCode 配置中，例如：

```text
{
  "permission": { "bash": "allow" },
  "plugin": ["opencode-smart-approval"],
  "small_model": "provider/reviewer-model"
}
```

如果 OpenCode 在执行前就 deny 或 ask `bash`，本插件不会收到该工具调用。可选的 `small_model` 按下文的模型优先级参与选择。

## 决策管线

每个受支持的 Shell 调用都复用同一份分析和同一个已加载策略快照：

```text
配置访问守卫 → 用户规则 → 内置规则 → Tirith → OpenCode 直接审批 Agent
```

| 阶段 | 行为 |
|---|---|
| 配置访问守卫 | 已证实会写入当前审批策略的操作直接阻断；无法排除策略写入的操作不能走 allow 快速路径，而会继续审查。 |
| 用户规则 | 完整的显式 deny 立即终止；完整显式 allow 也会终止，除非配置访问守卫强制审查。部分匹配、未匹配或显式 review 会继续。 |
| 内置规则 | 仅为基础 Shell 连接与查看命令提供极小、平台无关的快速路径。 |
| Tirith | 扫描完整、未拆分的命令。block 立即终止；allow 或 warn 会携带扫描证据继续。 |
| 审批 Agent | 在 OpenCode 中创建受限子会话，验证最终运行时身份，提交有界证据，解析一个严格裁决，并在失败时封闭。 |

对于管道或列表，必须所有静态解析出的可执行段都获准，allow 才能短路。任一段 deny 都拒绝整条命令。同优先级冲突按 `deny > review > allow`；先比较更高的整数 `priority`。

## OpenCode 根客户端直连架构

生产代码复用插件收到的精确根 `PluginInput.client`。它不导入 SDK `/v2` 客户端、不构造另一个 OpenCode 客户端或服务器、不调用 `opencode run`，也不启动 OpenCode 子进程。按照 OpenCode 1.17.14 的声明，每个根方法只接收一个生成的 options 对象，其中 `path`、`query`、`body` 和 `signal` 位于固定层级。插件只捕获一次这些方法，并使用：

- `app.agents` 与净化后的 `app.log`；
- `session.messages`、`session.create`、`session.prompt`、`session.abort` 和 `session.delete`。

审查器确实会在已经运行的 OpenCode 实例中创建子会话。这修正了旧文档的“无会话”错误：不会启动额外 OpenCode 进程，但审查会话会由宿主保存，直到生命周期策略删除或用户明确选择保留。

1.17.14 的生成声明与运行时传输并不完全一致。生成声明暴露 `builtIn`、`tools`、`maxSteps` 及旧权限形状；实测 `app.agents` 运行时则暴露 `native`、`steps`、规范化权限规则，以及可为 null 的 `hidden`、`topP`、`color`、`variant`。运行时消息数据也包含滞后于声明的源字段。因此所有客户端响应先视为 unknown，再由严格、锁定到源代码的 schema 解析；未知字段、错误 null 规则、重复固定 Agent 或身份漂移都会失败封闭。

## 策略版本 3

可信全局策略位于 `~/.config/opencode/command-approval.jsonc`，或 `$XDG_CONFIG_HOME/opencode/command-approval.jsonc`。文件不存在时会用 v3 默认值创建。

项目可以提供 `./command-approval.jsonc`，但只有可信全局文件设置 `"allow_local_config": true` 时才使用。本地文件启用后会完整替代该项目的全局策略，因此应把已启用的项目策略视为可信代码。

最小有效策略是：

```jsonc policy-v3
{
  "version": 3,
  "review": {}
}
```

版本 3 有意采用严格模式。顶层、`review`、`self_protection`、`tirith`、`rules` 以及每条规则对象都拒绝未知字段。字符串简写、别名、无版本/v1/v2 文档及旧 `command-approval.json` 文件名都会被拒绝，不提供兼容回退或自动替换。

### 策略选项

| 选项 | 默认值与契约 |
|---|---|
| `version` | 必填字面量 `3`。 |
| `allow_local_config` | `false`；只从可信全局文件读取。 |
| `self_protection.enabled` | `true`；启用尽力而为的配置访问守卫。 |
| `review.model` | 默认不存在；出现时必须是精确 trim 的 `provider/model` 身份，model 部分可以包含后续 `/`。 |
| `review.timeout_ms` | `45000`；`1000` 到 `300000` 的安全整数。 |
| `review.context_messages` | `20`；`0` 到 `200` 的安全整数；`0` 禁用审查器对话上下文。 |
| `review.prompt` | 默认不存在；精确 trim 的非空可信策略后缀，最多 8,192 个 UTF-16 code unit。它附加在不可变安全契约之后，不能替换契约。 |
| `review.cleanup_session` | `true`；普通完成后按精确 ID 删除审查子会话。 |
| `tirith.enabled` | `true`。 |
| `tirith.path` | 默认不存在；精确 trim 的本地二进制绝对路径会跳过自动下载。 |
| `tirith.timeout_ms` | `5000`；`500` 到 `60000` 的安全整数。 |
| `tirith.fail_open` | `false`。 |
| `rules.deny`、`rules.review`、`rules.allow` | 用户列表默认为空，之后仍合并极小内置规则集。 |

每条规则都是严格对象：必填非空 `match`，以及可选非空 `reason`、`scope: "command" | "segment"`、安全整数 `priority`。针对可执行文件的信任应使用 segment scope。只有分析得到恰好一个静态可执行节点时，command-scope allow 才有资格终止后续阶段。

### 模型优先级

固定审批 Agent 按以下精确顺序选择模型：

1. 审批策略中的有效 `review.model`；
2. OpenCode `opencode.json` 或 `opencode.jsonc` 中的 `small_model`；
3. 省略 Agent 的 `model` 属性，让 OpenCode 继承其已配置选择。

只要策略中出现无效 model，策略加载就会失败，绝不会回退到 `small_model`。

## 从 v1/v2 破坏性迁移

配置兼容已明确移除，因此迁移必须手工完成：

1. Provider URL、API key、Provider 插件及 Provider 模型定义继续放在 OpenCode 自身配置中。
2. 创建 `command-approval.jsonc`，写入必填 `version: 3` 和必填 `review: {}`；不要继续使用旧 `.json` 文件名。
3. 将个人规则复制为 `rules.deny`、`rules.review`、`rules.allow` 下的严格对象条目。
4. 只按上表加入当前 v3 的审查、Tirith、本地策略或守卫选项。
5. 启动 OpenCode 后按报告的精确字段类别修正；加载器不会猜测旧语义。

下面是不能复制的已移除形状示例。严格加载器会先在 `version` 类别拒绝它，不会使用任何退役字段：

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

已移除标识包括 `base_url`、`api_key`、`max_script_bytes`、`max_tool_calls`、`max_retries`、`rules.block`、`risk_tool`、camelCase 别名、字符串规则简写及版本 1/2 迁移行为。Provider 传输和认证现在完全归 OpenCode 管理；审查器上限与工具由插件固定，不再由策略控制。

## 固定受限审批 Agent

配置钩子会在自身加载顺序位置覆盖固定名称 `opencode-smart-approval-reviewer`，并保留无关 Agent。独立冻结的预期配置包含：

- 固定描述 `Reviews one shell command for opencode-smart-approval using only the plugin-owned guarded reader.` 及不可变安全契约；
- `mode: "subagent"`、`steps: 4`、`temperature: 0`；
- 所选的可选模型；
- 权限 map `{"*":"deny","external_directory":"deny","opencode_smart_approval_read":"allow"}`。

创建前及 prompt 前，`app.agents` 都必须暴露恰好一个匹配 Agent，并满足固定描述、prompt、mode、steps、temperature、model、空 options、`native: false`、不存在已启用的可选覆盖，以及以下精确最终规范化权限后缀：

| Permission | Pattern | Action |
|---|---|---|
| `*` | `*` | `deny` |
| `external_directory` | `*` | `deny` |
| `opencode_smart_approval_read` | `*` | `allow` |

OpenCode 可以在末尾追加一条宿主管理的精确 `.../opencode/tool-output/*` 目录 allow；再出现其他后续权限规则就验证失败。每次 `session.prompt` 还会发送精确工具 map `{"*":false,"opencode_smart_approval_read":true}`。

本插件不会向审批 Agent 授予 Shell、网络、通用 read/list、write/edit、question 或权限管理工具。这是 OpenCode 工具调度限制，不是 OS 沙盒。

## 受守卫读取器边界

唯一由插件提供给审查器的工具是 `opencode_smart_approval_read`，严格参数为 `path` 与可选非负安全整数 `offset`（默认 `0`）。单次调用最多返回 65,536 字节。

访问必须同时匹配当前拥有的子会话 ID、固定 Agent 名称、规范化审查目录、worktree、活动 generation 以及未中止的 prompt。清理前先撤销所有权。

- 工作区文件在锚定的 workspace 根下按需打开。
- 工作区之外，只租约共享 Shell 分析静态引用、且位于规范化临时根或独立 worktree 下的精确现存文件；Agent 不能浏览整个临时目录。
- 每个路径组件都通过锚定描述符遍历。最终目标必须是只有一个链接的常规文件；符号链接、硬链接、特殊文件、路径穿越、畸形路径和作用域逃逸都失败封闭。
- 临时引用保留 activation 时打开的精确描述符快照；工作区读取在有界 read 前后比较描述符。撤销、路径替换或身份变化不能切换被审批的字节。

权威 POSIX 敏感路径谓词不区分大小写，并拒绝任何以 `/` 或 `=` 分隔、值等于 `.env`、`.env.local`、`.git`、`.git-credentials`、`.netrc`、`.npmrc`、`.pypirc`、`.ssh`、`.aws`、`.docker`、`.kube`、`.azure`、`auth.json` 的组件；任何以 `.env.` 开头的组件；`.config/gh` 与 `.config/gcloud`；以及精确 `/proc/self/environ`、`/proc/thread-self/environ` 或数字进程/task 的 `environ` 路径。反斜杠在 POSIX 中仍是普通字符。描述符遍历前，会分别对请求拼写、根相对拼写和绝对拼写应用此谓词。

## 上下文与授权边界

审查器可以看到有界证据：命令、规范化 cwd、工具参数、Shell 分析、匹配规则、Tirith 结果、静态引用及投影后的父会话 transcript。策略 `context_messages` 限制请求消息数；独立上限约束复制 envelope、单 part/总文本、part 数、工具名及完整序列化审查请求。synthetic/ignored 文本、附件、summary、不支持的 part、畸形身份/顺序及原始确认短语会被排除或失败封闭。

Transcript 文本只是证据，不是插件授权。用户可以在其中表达意图，审查器也可以独立判断某动作安全；但引用命令、助手文本、旧审批、泛化的“继续”以及所有 challenge 之前的陈述，都不会成为插件确认。只有下文由插件生成的 `authorization_proof` 才能授权确认路径。

## 一次性知情确认

审查器返回 `needs_confirmation` 时，必须给出具体 `action`、`data`、`destination`、`risk`。插件会阻断第一次尝试，并渲染这四项、完整命令、规范化 cwd、effect/disclosure SHA-256、替换状态、300 秒作用域，以及以下精确形式短语：

`AUTHORIZE opencode-smart-approval <43-character-base64url-nonce>`

确认要求在已保存边界之后，父会话中恰好出现一条新的普通用户消息，且内容精确等于该短语。不进行 trim、大小写折叠、Unicode 规范化；不允许附加文本、assistant/synthetic/summary 替代或歧义。Challenge 绑定父会话、边界 tuple、规范化 cwd、命令 effect hash、disclosure hash、generation 与过期时间。

Nonce 只能使用一次。成功匹配会原子消费；重放、不匹配、过期、effect 改变、边界被替换/驱逐或出现多条新消息都会失败封闭。用户响应前的自动重试会继续等待，不会旋转 challenge。匹配重试不会直接放行：它会携带仅含 hash 的证明重新运行 Tirith 与审批 Agent，第二次审查仍必须独立 allow。

明文 nonce 必然出现在面向父会话的错误与用户响应中，因此可能留在 OpenCode 父会话 transcript 或宿主存储。插件状态只保存 SHA-256 token hash；每个父会话最多保留 64 个 active/recent hash、最长 24 小时，只用于从审查器 payload 中擦除完整短语及嵌入式 token。会话删除或插件 dispose 会清除这些 hash。

固定版本 OpenCode 1.17.14 可以通过 `ToolContext.ask` 发起自定义 permission，但它的自定义权限 UI 会把所给风险元数据隐藏在通用工具调用后，并且即使没有有用的永久 pattern 也会显示 `Always allow`。`permission.ask` 插件钩子只能观察请求，不能提供本插件的完整披露协议。因此本插件不会把原生自定义 permission、question、动态 permission 名或 permission reply 当作知情同意。

## 面向用户的错误安全

不可信工具名、规则/扫描器/Provider/审查器 reason、路径及确认字段统一经过一个 renderer。它转义反斜杠、引号、反引号、控制字符、双向控制符与 BOM；无效 UTF-16 在普通错误中安全替换，并使确认渲染失败。

普通阻断错误把转义后工具名限制为 1,024 字节、单条 reason 1,024 字节、reason 数 16、category 数 32、reason 聚合文本 8,192 字节、完整 body 16,384 字节。确认不会截断单个披露字段：转义后的 command 上限为 8,192 字节，完整 body 上限为 16,384 字节；超限就失败封闭。

## 审查会话生命周期

预检查成功后，每次审查至多创建一个精确子会话，并按 ID、目录、固定 Agent 类型、prompt settlement 与 reader lease 跟踪。所有清理操作共享一个幂等 promise，因此 idle、deleted、instance disposed、hook dispose、超时及 late settlement 路径不会删除外部会话或重复删除。

默认 `review.cleanup_session: true` 时，普通成功先撤销 reader lease，再删除精确子会话。异常完成会先撤销访问，按需中止尚未 settle 的 prompt，在时限内 drain，然后尝试精确删除；即使 cleanup 被关闭，异常路径也一样。匹配的外部 `session.deleted` 事件会被视为已删除。

`cleanup_session: false` 时，只有完整 settle 的普通审查可以保留为 inactive 会话：reader lease 已撤销，不再有 adapter promise 或工具调用。保留会话会留在 OpenCode 数据库，直到用户或后续 harness 删除。Dispose 不会重新解释已保留的成功，但会清理仍处于 active 的自有审查。

## Tirith 完整性与离线行为

配置 `tirith.path` 时必须使用绝对路径。未配置时，插件选择平台资产，下载有界 release/checksum/archive 数据，校验上游 archive SHA-256，在严格条目/大小限制下解压，记录二进制摘要，并原子安装到缓存。

小于 24 小时的缓存只有在元数据及当前二进制摘要匹配时才复用。刷新不可用时，过期缓存只有在重新读取元数据并重新验证精确二进制、asset、release、archive digest 与 binary digest 证明后，才可明确返回 `stale_verified`。畸形上游数据、已变化/撤销 release、缺失证明或被篡改字节都不能走 stale 回退。扫描器执行失败按可信 `tirith.fail_open` 处理，默认失败封闭。

## 配置访问守卫的限制

`self_protection.enabled` 控制一个尽力而为的执行前守卫，保护当前 reload-effective 全局策略，以及仅在显式启用时的本地策略。它会阻断已证实的 Shell 重定向/写入器及已识别的 OpenCode `write`、`edit`、patch 目标。静态歧义会强制进入 deny 之后的审查路径，因此宽泛 allow 不能静默绕过；已证实的只读操作和相邻/非活动文件不会被误阻断。

该守卫不是文件系统 ACL，无法阻止手工编辑、其他进程、宿主/core 修改、未观测到的共存插件行为或所有 TOCTOU 竞争。未知文件工具与动态 effect 可能不可见，或只能强制审查。只有在其他控制已承担风险时，才应在可信全局策略中关闭它。

## 宿主、插件与沙盒信任

OpenCode 1.17.14 以进程为单位加载插件，不存在针对某个审查子会话的插件开关。本插件永不修改 `OPENCODE_DISABLE_DEFAULT_PLUGINS` 或 `OPENCODE_PURE`：

- 启动后修改 `OPENCODE_DISABLE_DEFAULT_PLUGINS` 无法改变单个子会话；启动时设置它还会移除已配置模型依赖的内置 Provider 集成；
- `OPENCODE_PURE` 会移除包括本审批插件在内的外部插件；
- 两者都保持不变，用户现有 OpenCode/Provider 插件配置才继续作为权威配置并保持可用。

产品没有 `pure` 选项。只有后续、不会打包发布的 Todo 12 验证 harness 负责隔离的 boot-only disable-default-plugins 探针；生产代码不会复制该环境。

配置钩子会在自身加载位置覆盖同名 Agent，运行时字段/权限验证也能检测后续 Agent 修改。但 `app.agents` 既不暴露实际启用工具 map，也不提供工具定义来源。OpenCode 可能保留重复同名工具定义，而后续 session 组装可能选择更晚的共存插件定义。因此恶意或不兼容插件可以替换受守卫读取器实现或改变宿主行为。必须审查完整插件列表，并把共存插件与 OpenCode 本身视为可信。

固定 permission/tool map 只限制 OpenCode 调度，不隔离 Provider 代码、插件、宿主进程、文件系统 syscall 或网络访问。允许网络的更广 OS 沙盒仍然推迟，因为 OpenCode 配置/data/cache/state/Provider 访问需要单独设计。

## 隐私摘要

- 所选 Provider 可以看到有界审查请求，以及模型与唯一受守卫读取器的交互。
- 审批子会话位于现有 OpenCode 进程/数据库中，并默认按精确 ID 删除。
- 父会话确认明文可能保留在父 transcript；审查器副本通过只存 hash 的历史记录擦除。
- Tirith 自动下载与模型/Provider 流量遵循各自配置的网络路径。
- 插件不会启动 `opencode run`、构造第二个客户端/服务器，也不会改变 Provider/插件环境标志。

## 开发

```sh
bun install
bun run typecheck
bun test
```

## 参考项目

- [OpenCode](https://github.com/sst/opencode)
- [Tirith](https://github.com/sheeki03/tirith)
- [OpenGuardrails Instrumentation for OpenCode](https://github.com/openguardrails/openguardrails-instrumentation-opencode)
- [OpenAI Codex CLI](https://github.com/openai/codex)

## 许可

MIT
