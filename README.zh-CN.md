# opencode-smart-approval

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[OpenCode](https://github.com/sst/opencode) 的 Shell 命令智能审批插件。通过 [Tirith](https://github.com/sheeki03/tirith)、Tree-sitter Shell 分析、确定性规则和带只读工具的 LLM 审查，在不降低安全性的前提下减少审批成本。

OpenCode 不提供命令沙盒，因此默认放行只覆盖在用户完整主机权限下仍可证明安全的命令和参数。

## 工作原理

每条 shell 命令（`bash`、`shell`、`exec_command` 等）经过以下管线：

```
原始命令 → Tirith → Shell 解析 → 强制守卫 → 逐段规则 → 全局聚合 → 必要时 LLM 审查
```

| 阶段 | 行为 |
|------|------|
| **Tirith** | 首先扫描完整、未拆分的原始命令。阻断为最终结果，警告强制进入 LLM 审查。 |
| **Shell 分析** | 使用固定版本的 Tree-sitter Bash 语法提取静态可执行段。引号内容是数据；管道、列表、替换、重定向和后台任务是语法。 |
| **强制守卫** | 不可被覆盖地保护凭证、管道进 Shell、提权、破坏性操作、hook 绕过和可产生副作用的参数。 |
| **规则** | 用户规则与内置规则在每个可执行段上共同决策，再对完整命令聚合。 |
| **LLM 审查** | 任一命令段或语法问题需要判断时仅调用一次，并携带完整命令、只读文件工具和对话上下文。失败封闭。 |

同一命令段内先取最高整数 `priority`，同优先级再按 **block > review > allow** 决策。不同命令段之间也按 **block > review > allow** 聚合；管道或列表一侧的 allow 永远不能替另一侧授权。规则优先级不能覆盖强制守卫和 Tirith。

## 前置条件：bash 权限放行

OpenCode 必须允许 bash 工具，命令才能到达本插件。在 `~/.config/opencode/opencode.json` 中：

```json
{
  "permission": { "bash": "allow" },
  "plugin": ["opencode-smart-approval"]
}
```

插件通过 `tool.execute.before` 钩子拦截——只有在 OpenCode 本来会执行命令时才触发。如果 bash 设为 `deny` 或 `ask`，插件没有机会审查。

## 安装

```sh
npm install -g opencode-smart-approval
```

## 配置

插件将全局配置作为可信策略边界：

1. **全局** — `~/.config/opencode/command-approval.jsonc`（或 `$XDG_CONFIG_HOME/opencode/`）。首次运行时如不存在则自动生成默认配置。
2. **本地** — 项目目录下的 `./command-approval.jsonc`。项目文件可能不可信，因此默认忽略。只有全局文件显式设置 `"allow_local_config": true` 时，它才会替代全局配置。

创建全局配置（支持 JSONC 注释）：

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
    // "prompt": "..."  // 覆盖默认审查策略
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
        "reason": "可信的个人检查工具"
      }
    ]
  }
}
```

文件不存在时插件首次运行自动生成默认配置。`review` 端点独立配置——插件不读取 OpenCode 自身的模型/认证配置。

### 选项

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `version` | `2` | 用于生成策略迁移的配置格式标记；只接受版本 1 和 2。 |
| `allow_local_config` | `false` | 允许项目本地配置完整替代全局策略。只从可信全局文件读取。 |
| `review.base_url` | — | OpenAI 兼容端点 URL。**必填。** |
| `review.api_key` | — | API 密钥。**必填。** |
| `review.model` | — | 模型名。**必填。** |
| `review.timeout_ms` | `45000` | LLM 审查超时（5000–300000）。 |
| `review.max_script_bytes` | `20000` | 发送给审查器的脚本最大字节数。 |
| `review.max_tool_calls` | `3` | 每次审查的只读工具调用上限（0–10，0 禁用工具）。 |
| `review.max_retries` | `3` | 首次请求后的 LLM API 最大重试次数（0–10 整数，0 禁用重试）。 |
| `review.context_messages` | `20` | 注入为对话上下文的近期会话消息数（0–100，0 禁用）。 |
| `review.prompt` | 内置 | 覆盖审查策略文本。详见 [LLM 审查](#llm-审查)。 |
| `tirith.enabled` | `true` | 启用 Tirith 扫描。 |
| `tirith.path` | 自动 | 本地二进制路径。跳过自动下载。 |
| `tirith.timeout_ms` | `5000` | 每条命令的扫描超时。 |
| `tirith.fail_open` | `false` | `true` = 扫描失败时放行。 |
| `rules.block` | `[]` | 添加可配置阻断规则。强制守卫独立存在且始终生效。 |
| `rules.review` | `[]` | 添加强制 LLM 审查规则。 |
| `rules.allow` | `[]` | 为已证明安全的命令段跳过 LLM 审查。内置规则仍自动生效。 |

## 规则

规则可以是正则字符串，也可以是带 `match`、可选 `reason`、`scope` 和 `priority` 的对象。旧字符串和旧对象继续按 `scope: "command"`、`priority: 0` 兼容；新的管道友好规则应使用 `scope: "segment"`。

加载无版本或 version 1 配置时，插件只忽略 v2 之前自动写入的六条精确紧凑字符串 **allow** 模式，避免过时的宽泛包脚本、构建和测试授权在升级后继续生效。自定义对象和修改过的模式都会保留。如果确实需要其中某条旧 allow，请设置 `version: 2`，并将其改写为带明确 `scope: "segment"` 和有意设置的 `priority` 的规则。

未知的未来配置版本会直接拒绝加载，不会按旧版本语义猜测解释。

```jsonc
"block": [
  // 旧简洁写法：整条命令、优先级 0
  "^(?:printenv|set)(?:\\s|$).*",

  // 显式写法
  { "match": "^dangerous-tool(?:\\s|$).*", "scope": "segment", "priority": 100 }
],
"review": [
  { "match": "^deploy(?:\\s|$).*", "scope": "segment", "priority": 50 }
],
"allow": [
  { "match": "^my-reader(?:\\s|$).*", "scope": "segment", "priority": 100 }
]
```

**各类型适用场景：**

- **block** — 绝不允许执行的命令。立即拒绝，无 LLM 成本。
- **review** — 需要上下文判断的命令（如 `git push`、`npm publish`）。强制 LLM 审查，附带完整对话上下文和只读工具。
- **allow** — 按模式安全的命令。跳过 LLM 审查（除非 Tirith 警告）。

`scope: "segment"` 匹配解析后的精确可执行段，因此 `my-reader | grep value` 只有在两段都放行时才能整体放行。整命令作用域的 allow 仅在命令只有一个静态可执行节点时生效；整命令 block/review 仍可升级复合命令。

分段规则匹配前会规范化静态可执行文件的引号、转义及拼接写法。强制守卫同时使用解析后的选项和参数值，并保留原始拼写用于检查可能发生的展开。命令前缀环境变量赋值、文件描述符复制、`/dev/null`、边界内的输入重定向，以及写入规范化系统临时目录的输出重定向可以继续静态分析；敏感重定向目标会阻断，输出到其他位置则审查。管道、逻辑/分组命令和纯重定向语句中的重定向都会统一收集。会改变可执行文件查找、加载器、Git/GitHub 辅助程序或工具配置的赋值仍需审查；独立赋值会改变后续 Shell 状态，因此也需审查。含义不明确的 word、动态命令名、命令替换、heredoc、后台任务、不支持的控制结构、畸形输入以及资源上限超限都会只触发一次审查。解析器、运行时或资产初始化失败会直接失败封闭阻断。

即使静态嵌套 Shell 的内部命令都能完整恢复，外层仍会进入审查。Shell 启动文件和环境中的解释器状态不在命令 AST 内；OpenCode 又没有沙盒，因此不能可靠地自动放行 `sh -c`/`bash -c`。

## LLM 审查

审查器接收：命令、工作目录、工具参数、匹配规则、Tirith 发现、脚本证据、近期对话上下文。返回结构化裁决（`outcome`、`risk_level`、`user_authorization`、`categories`、`reasons`）。

### 只读工具

审查器有两个工具用于在决策前验证本地状态：

- **`read_file`** — 读取文件内容。规范化目标必须在 cwd 或系统临时目录内，且不能是敏感路径。
- **`list_files`** — 列出目录内容。同样的路径限制。

路径会沿现有父目录和符号链接规范化，再检查是否位于规范化后的 cwd、`tmpdir()`、`/tmp` 或 `/private/tmp` 内。越界路径、敏感凭证/配置路径会向 LLM 返回错误；脚本证据使用同一边界。工具调用次数受 `max_tool_calls` 限制。

### 对话上下文

插件通过 OpenCode SDK client（`session.messages`）获取当前会话的近期消息，提取文本和工具调用摘要，注入为对话上下文。这为审查器提供了用户意图和授权信息——对齐 [Codex](https://github.com/openai/codex) guardian 模型。设 `review.context_messages` 为 0 可禁用。

### 自定义 prompt

默认审查策略涵盖证据处理、用户授权评分、风险分级、调查指南、裁决策略。通过 `review.prompt` 可覆盖——提供完整策略文本，插件替换内置策略。JSON 数据（命令、规则、对话上下文等）始终附加在自定义策略之后。

### 拒绝反馈

审查器拒绝时，`reasons` 通过 `CommandApprovalError` 传回 OpenCode——AI agent 看到拒绝原因，可以选择更安全的替代方案或向用户请求明确授权。

## 内置规则

**强制阻断** — 凭证文件和敏感 glob（大小写折叠、符号链接规范化，并识别 Git 对象路径与隐含文件递归搜索）、密钥展开（包括 jq `env`/`$ENV`）、管道目标子树中任意位置进入 Shell、钥匙串秘密、`sudo`、环境导出（包括会在启动或错误路径打印完整进程环境的 `ipatool` 等 Apple 工具）、破坏性磁盘/文件操作、git hook 绕过、破坏性推送、GitHub token/管理/认证/密钥操作和无人值守嵌套代理。进入守卫前会规范化带引号或转义的命令名，以及 `command`、`exec`、`time`、`env`、`builtin` 和 BusyBox 分发。

**强制审查** — 会写入、执行或间接读取的选项，包括 ripgrep 辅助程序、压缩包解压和符号链接跟随，`sort` 输出/临时目录/列表输入，校验清单，`file` 魔数/列表/解压模式，jq 测试/外部程序/模块，`ffprobe` 协议与报告，设置时间的 `date`，不满足严格只显示语义的 `sed`，会产生副作用的 Git 参数/子命令，以及未显式关闭 external diff 和 textconv helper 的补丁型 Git 查看命令，文件写入和非临时目录输出重定向、高风险环境变量赋值、目录/进程分发器、嵌套 Shell/解释器脚本和打开浏览器的 GitHub 参数。受保护命令若无法解析，或按 Shell `PATH` 语义解析到不可信可执行文件，也需要审查。`xcrun` 只有在目标工具实际解析到当前 Xcode 开发目录内时才继承信任；随后会先规范化目标的真实名称和 Swift/Clang 别名，再按工具族检查。宿主解释器和进程启动器、会产生副作用的 Git、Shell 执行、编译器响应文件/config/CAS/插件/helper 加载、Xcode 外部配置/构建 helper/高风险环境覆盖，以及系统/PATH 回退工具仍受各自守卫约束。

**内置审查** — 普通 `git push`、包发布和容器仓库写入。

**内置放行** — 静态过滤与检查命令（`grep`、`rg`、`jq`、`sort`、`cat`、严格只显示的 `sed -n` 等）、Shell 胶水命令（包括外部或裸 `printf`，但排除设置变量的 `-v`）、文件系统/主机检查、有限的只读 Git/GitHub 命令和部分 macOS 诊断命令。安全的 Git 全局选项可以放在只读子命令前。文件读取器的操作数、辅助输入、活动 glob 和 tilde 展开会按命令语义解析，并且必须留在当前工作目录或系统临时目录内；逃逸的符号链接和外部路径需要审查。ripgrep 的目录操作数会在放行前进行有上限的递归扫描：普通搜索检查可见后代，`--hidden`/unrestricted 形式还会检查隐藏后代。

由于 OpenCode 没有沙盒，项目代码执行（包脚本、测试、构建、解释器）、文件系统写入和 iOS 开发工具不会被通用默认规则放行。应将明确可信的项目或用户专属命令写成显式 segment 规则；它们只能覆盖同一命令段的普通策略，不能覆盖强制守卫或其他命令段的决策。

因此用户可以把 `xcodebuild`、`xcodebuildmcp`、`sim-use`、`asc`、`xcrun` 等 iOS CLI 整体加入自己的规则。普通 Apple SDK 选择、默认 Xcode toolchain、解析到所选 Xcode 开发目录内的工具、已知 Swift Package 子命令、Swift 的非执行查询/typecheck 模式，以及设备侧 `simctl`/`devicectl` 可以使用用户放行规则；自定义 SDK/toolchain 或 `SDKROOT`/`TOOLCHAINS`、Swift 脚本/REPL/动态插件命令、编译器响应文件/config/CAS/插件 helper、App Intents 元数据工具链覆盖、`xctrace --launch`、宿主侧启动器和解释器、Xcode xcconfig 或编译器/链接器/环境覆盖（包括含 helper 的 `OTHER_*FLAGS`）、会产生副作用的 Git、不安全环境变量，以及解析到所选开发目录外的工具仍会审查或阻断。

## Tirith

[Tirith](https://github.com/sheeki03/tirith) 是用 Rust 编写的终端安全扫描器。它捕捉正则无法覆盖的威胁：西里尔字母同形字 URL、ANSI 转义注入、base64 解码执行链、通过 `curl` 上传的凭证外泄、管道脚本中的混淆载荷、不可见 Unicode 隐写。对干净输入的开销在亚毫秒级。

### 自动下载

未设置 `tirith.path` 时，插件首次使用自动下载适合当前平台的最新发布版本，校验上游 SHA-256，并连同发布版本、压缩包摘要、二进制摘要和新鲜度元数据缓存到用户缓存目录。复用缓存时先校验本地二进制，并在 24 小时后刷新上游发布与 checksum；发现新版本或摘要变化时原子安装。HTTP 响应体、重定向次数、总耗时、压缩包大小、条目边界、解压后大小和二进制大小均有上限。平台不支持或发布资产缺失时，与扫描器执行失败一样按 `tirith.fail_open` 决策。

| 平台 | 支持 |
|------|------|
| macOS arm64 / x64 | ✅ |
| Linux glibc arm64 / x64 | ✅ |
| Linux musl arm64 | ✅ |
| Windows x64 | ✅ |

## 隐私

- 审查器可见：命令、工作目录、工具参数、匹配规则、Tirith 发现、引用的脚本内容、近期会话对话上下文。
- 只读工具和脚本证据会先规范化，再限制在 cwd 与系统临时目录内；敏感路径和符号链接逃逸会被拒绝。
- 插件不创建 OpenCode 会话，不调用 `opencode run`。

## 开发

```sh
cd opencode-smart-approval
bun install
bun run typecheck
bun test
```

## 参考项目

- [OpenCode](https://github.com/sst/opencode) — 本插件扩展的开源编码 Agent。提供 `tool.execute.before` 钩子和 `permission` 模型，使命令拦截无需修改核心代码即可实现。
- [OpenGuardrails Instrumentation for OpenCode](https://github.com/openguardrails/openguardrails-instrumentation-opencode) — 采用 OGR 协议的同类 guardrails 插件。同样使用 `tool.execute.before` 插桩模式，支持文本/正则规则和可选 LLM judge；本项目采用了不同路线，集成了 Tirith 并构建了分阶段的解析与策略管线。
- [OpenAI Codex CLI](https://github.com/openai/codex) — OpenAI 的终端编码 Agent。其沙箱自动审批模型启发了本插件的失败封闭默认值、只读工具设计，以及基于对话上下文的证据驱动审批。
- [Dyad](https://github.com/dyad-sh/dyad) — 本地开源 AI 应用构建器。其权限钩子和策略配置模式影响了本插件的 JSONC 配置设计以及确定性规则与上下文审查的分离。
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) — Nous Research 的自我改进 AI Agent。其内置 Tirith 集成（自动安装、checksum 校验、断路器 fail-open 逻辑）直接启发了本插件的 Tirith 自动下载和失败封闭行为。
- [Tirith](https://github.com/sheeki03/tirith) — 本管线第一级使用的终端安全扫描器。在命令执行前拦截同形字 URL、管道注入、ANSI 注入、混淆载荷、凭证外泄和恶意 AI 技能文件。

## 许可

MIT
