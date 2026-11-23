# V0.3.2：服务商设置与模型连接测试

验收日期：2026-11-23 至 2026-11-24。起点提交：`3c3cabf`（安全保存服务商 API Key），已获用户确认并推送。

## 实际能力与范围

后台新增 `provider.test`：显式选择服务商与模型，使用共享 Models 解析已有凭据，发送固定的短请求，确认该模型当前是否可以调用。它不接受任意聊天提示，不读取、创建或写入 Conversation / Transcript。

实施前重新阅读 [ADR-0001](../architecture/0001-runtime-boundaries.md)，核查 Git、Host、凭据适配器、Handler Registry 和已安装 `pi-ai@1.5.0` 的 `Models.checkAuth` / `completeSimple`、请求超时 / 取消 / fetch / onPayload 选项及对应 API 实现。

这是连接诊断，直接复用 pi-ai 的认证与协议客户端，不新增 Agent Loop、Scheduler、Provider Registry、数据库或凭据副本。自定义 endpoint 与配置持久化留待独立增量。连接诊断后端与桌面设置入口作为同一个功能交付，不单独发布后台子步骤。

## 桌面设置入口

在现有 Conversation 面板后增加可折叠的“服务商设置”，通过现有 Rust RuntimeClient 转发目录、凭据状态、保存、删除与连接测试六个命令。默认选择 DeepSeek；模型选择仅用于连接测试，不宣称已设置聊天模型。

- 目录额外返回 `supportsApiKey`、`supportsConnectionTest` 能力标记，界面据此禁用未支持的操作。
- 密钥从密码框直接提交，提交后立即清空，不进入 React 状态、浏览器持久存储，也不回填已有凭据。切换服务商或收起设置会丢弃未保存密钥。
- 未保存的新 Key 会阻止连接测试；保存、删除或测试期间阻止服务商切换与重复提交。保存 / 删除失败后必须刷新实际状态。
- 仅展示经过映射的错误文案，不显示底层原始异常。异步加载有卸载保护，旧服务商结果不会覆盖新选择。
- 保留既有 Conversation / Transcript 组件与数据库。未增加聊天、Router / Worker 或自定义端点设置。

运行时可信启动环境可通过 `PI_STUDIO_CREDENTIAL_SERVICE` 指定独立系统凭据命名空间，用于隔离桌面验收；默认仍是正式应用命名空间。此变量不是 API Key，不接受前端参数。

新增 `pnpm run ui:test`，使用 Playwright 对模拟 Tauri 边界验证上述流程。首次运行需 `pnpm exec playwright install chromium`；也可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定本机 Chromium 浏览器。此依赖仅用于开发测试。

## IPC 契约

方法：`provider.test`，params：`{ providerId, modelId }`。仅接受这两个字段，去除首尾空白后分别要求 1–128、1–256 个字符。

成功返回：`{ providerId, modelId, connected: true, durationMs }`。耗时包含本次凭据检查与请求过程；不返回模型正文、原始响应、密钥或认证来源。

| 错误码 | 含义 |
| --- | --- |
| `INVALID_PARAMS` | 参数无效或包含多余字段 |
| `PROVIDER_NOT_FOUND` | 服务商未注册 |
| `MODEL_NOT_FOUND` | 指定服务商目录中没有该模型 |
| `PROVIDER_NOT_CONFIGURED` | pi-ai 未找到完整认证配置 |
| `PROVIDER_TEST_UNSUPPORTED` | 当前模型 API 或认证方式不在本阶段范围 |
| `PROVIDER_TEST_TIMEOUT` | 超过连接检查的时间预算 |
| `REQUEST_CANCELLED` | 调用者取消 |
| `PROVIDER_TEST_FAILED` | 请求、认证读取或上游模型响应失败，错误详情不回显 |

发出 `provider.tested` 事件，仅包含服务商、模型和连接结果。参数 / 目录校验失败时没有发送模型请求。

## 请求行为

- 仅显式调用接口时联网，不在启动、列目录或保存 Key 时自动检查。真实服务商可能按少量输入 / 输出 token 计费。
- 固定提示为 `Reply with OK.`，请求输出上限为 16 token，不提供工具、历史或任意提示；不启用额外思考配置，不要求正文必须等于 OK。
- 使用 pi-ai 原生 `completeSimple`、SSE 传输、8 秒总预算与 SDK 超时、零自动重试；传播原有 Handler 的取消信号。
- 通过 pi-ai 的 `onPayload` 核验最终输出上限，防止模型兼容配置省略或覆盖 token 限制；没有明确的有效上限或超过 16 时，在 HTTP 发送前失败。
- 通过 pi-ai 的 fetch 扩展拒绝 HTTP 重定向，不将凭据继续转发到重定向目标。
- 只有正常完成或达到输出上限的终态才返回连接成功。模型错误、取消、延迟任务等终态不算成功。
- 本阶段覆盖 API Key 认证及 `openai-completions`、`openai-responses`、`anthropic-messages`。不提供 OAuth 检查或其他协议的支持承诺；兼容端点若要求不同最小输出预算，也可能检查失败。

## 验证

- `pnpm run runtime:typecheck`、`pnpm run runtime:test`：通过，61 项运行时测试、0 失败、0 跳过。
- `pnpm run build`：通过。
- `cargo fmt --check`、`cargo test`：通过，10 项 Rust 测试与 main / doc tests 均通过。
- `git diff --check`：通过。
- 页面回归测试：4 项通过，覆盖保存 / 删除 / 测试流程、浏览器持久存储不保存密钥、迟到结果隔离、收起面板清空输入、错误脱敏与操作期间防止重复提交。
- 真实 `pnpm tauri dev`：在独立应用标识、独立数据目录和独立系统凭据命名空间中验证目录读取、合成 Key 保存、重启后恢复状态、密码框不回填和删除凭据。测试结束确认独立命名空间中凭据为 0。

Rust 首两次运行在本机启动环境下出现 2 项子进程 IPC 超时；未放宽超时、修改测试或跳过用例。原始进程环境复测 10 项通过，固定使用本机已安装的 Node 运行时后执行完整 `cargo test` 再次通过（含 main / doc tests）。此项启动环境差异保留为开发环境诊断记录。

新增六项测试覆盖固定请求与共享实例、参数 / 目录 / 认证检查、未支持协议与 OAuth、JSONL 错误和日志脱敏、真实本地 OpenAI 兼容 HTTP / SSE 调用、重定向拒绝、401 不重试、最终请求输出预算、超时及取消。现有独立 Runtime 进程测试额外确认正式入口已注册该方法。

所有模型网络请求只连接本地测试服务，使用合成凭据，没有读取用户真实 Key 或调用外部付费模型。真实桌面未执行付费连接测试。既有凭据恢复、Conversation、Transcript、IPC 与跨进程 SQLite 测试均通过。

## 下一步

实现最小自定义服务商 endpoint / 模型配置并验证重启恢复，继续复用唯一 Models；配置与凭据各自保存。标准 DashScope 的 endpoint 与认证应独立核实，不复用 `qwen-token-plan-cn` 的产品身份。

与后续自定义服务商配置合并交付，提交名称：`feat(provider): 支持服务商与模型配置管理`。用户已确认两轮合并提交并推送。
