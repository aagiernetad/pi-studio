# V0.3.3：最小可用模型对话

日期：2026-11-24。基于已推送的 `0df09b4 feat(provider): 支持服务商与模型配置管理`。

## 用户可见能力

在已有用户会话中选择服务商和模型、发送文本、查看生成中的正文、停止生成、失败或停止后继续上次生成，并直接在 Transcript 历史中阅读消息正文。每个会话保留自己的模型选择和上下文，切换会话不终止另一会话的生成。完成的对话与模型选择在重启后恢复。

本阶段限文本与 API Key 认证，覆盖 `openai-completions`、`openai-responses`、`anthropic-messages`；不引入 Router / Worker、工具执行、附件、模型自动路由或 Markdown 渲染器。

## 实施前核查与架构

重新阅读 ADR-0001、实际 Git 状态、旧交接文件、已有 Conversation 与 Provider 代码，并检查安装的 Pi Durable / Pi AI 1.5.0 类型和真实实现。

- 使用原生 `Conversation.submit`、Submission `requestId` 去重、`configure`、`AgentDoc`、`LiveDoc`、`Conversation.abort` 和 Harness 恢复机制。不新建 Agent Loop、Scheduler、Checkpoint、任务数据库或会话消息副本。
- 用户可见性继续从已有 Studio 会话索引检查，Root / 隐藏 Conversation 不可通过聊天接口访问。
- 一次提交先通过原生 `submissionByRequest` 查重，再校验模型和认证；同一事务中完成提交与模型配置。并发重试返回相同 Submission，忙时拒绝另一个新请求。
- 原生用户 Entry 使用受支持的 `studio.chat-input` 应用 kind，只附加 Provider / Model ID；内容仍由 Durable 原生提交机制写入模型上下文与 Transcript。相同 requestId 携带不同正文或模型返回 `REQUEST_ID_CONFLICT`。
- 发送 IPC 只等待提交落盘，不等待模型；Rust 仍复用现有 RuntimeClient。React 每秒串行查询原生状态，避免用一个长 IPC 请求等待整轮生成。
- 每个会话在原生 Agent 配置中禁用工具和扩展，最大一个工具轮次；没有注册可执行工具或环境。

## 请求边界与敏感错误

`chat-policy.ts` 在唯一 Models 的 `streamSimple` 入口包装现有 Pi AI 流，不替换集合、协议实现或 Durable 执行器。

- 单次最多 2048 个输出 token、60 秒预算、SSE、零 SDK 重试；在最终 payload 发送前核验输出上限，拒绝模型兼容配置绕过该上限。
- 不跟随 HTTP 重定向转发认证信息。
- 在 Durable 接收失败终态前重建通用错误消息，防止 SDK 原始异常、上游 401 内容或 Key 进入 Entry、任务结果与 Live 状态。成功正文与原生流进度继续交给 Durable 管理。
- Harness 使用原生重试配置关闭失败后的自动重试，并暂时关闭自动压缩，避免本阶段发出额外摘要调用。达到上下文上限时需要开始新会话或后续接入原生压缩。

API Key 仍只来自独立系统凭据存储；提交参数拒绝多余字段，不接受临时 Key、任意 headers 或 SDK 配置。输入最多 8000 字符。实时事件只发出 Conversation / Submission ID，不发正文、SDK 错误或凭据。

## 重启恢复的实际语义

已完成会话重启不会再次请求模型。正常关闭时尚未完成的生成会由 Durable 原生恢复，可能重新发送模型请求；不能承诺模型调用 exactly-once。相同的用户输入不会再次入库，客户端重试也不会新建 Submission。

最初的恢复测试误以为正常关闭等于一次失败尝试；查阅原生实现并实测后，改为验证其真实契约：正常暂停后恢复生成、用户 Entry 仅一条、重试仍返回原 Submission。没有通过修改 Scheduler 或增加自定义恢复状态绕过框架语义。

界面明确说明生成中退出可能再次调用模型，并提供“停止生成”。崩溃后的具体处理仍按 Durable 的任务检查点与重试策略执行，不承诺所有中断都能成功恢复答案。

## 前端异步和分页保护

- `ConversationChat` 按 Conversation ID 挂载；迟到模型、状态和提交结果不能覆盖新会话。
- 提交结果未知时保留同一 requestId 与消息，锁定编辑并提供“重试同一请求”，原始错误不回显。
- 停止调用原生 abort；会话切换只结束界面轮询，不自动取消另一会话的生成。
- “继续上次生成”调用 `conversation.chat.resume`，复用原生 `type: "continue"`，只创建新的 Continue Submission，不新增用户 Entry。使用上次发送时的原生 Agent 模型，界面明确提示该模型及再次调用的费用。
- 原生失败原因为 `aborted`、`model_error`、`interrupted`、`restart_limit`、`no_model` 时提供继续入口。空会话、已回答完成的会话不提供继续；忙时拒绝新的继续请求。恢复前检查模型和凭据，事务内再次检查会话状态。
- Continue 请求仍通过原生 requestId 幂等；同一 ID 不能与普通消息提交混用。结果未知时保留同一继续请求并锁定其他提交，后续重试不创建第二个 Continue。继续操作保留输入框中尚未发送的下一条草稿。
- 历史新增外部刷新标记；分页请求记住加载代次，避免生成新 Entry 刷新首页后把旧分页拼入。原有分页顺序和游标协议保持一致。
- Transcript 显示用户 / 助手正文，同时保留原有模型详情查看入口与非聊天 Entry 显示。

## 主要文件

- `runtime/src/durable/chat-handlers.ts`：提交、状态、停止、继续 IPC，原生幂等和可见性检查。
- `runtime/src/durable/chat-policy.ts`：Pi AI 流请求边界和敏感错误处理。
- `runtime/src/durable/host.ts`、`runtime/src/index.ts`：沿用原宿主接入策略与 Handler。
- `src-tauri/src/lib.rs`：提交、状态、停止、继续四个转发命令。
- `src/ConversationChat.tsx`、`ConversationPanel.tsx`、`ConversationTranscript.tsx`、`App.css`：现有界面增加文本对话与历史刷新保护。
- `runtime/src/durable/chat.test.ts`、`runtime/src/handlers/providers.test.ts`、`tests/provider-settings.test.mjs`：原生执行、正式入口和页面回归。

## 验收

- `pnpm run runtime:typecheck`：通过。
- `pnpm run runtime:test`：73 项通过，0 失败 / 取消 / 跳过。包括原生多轮上下文、并发幂等、请求冲突、模型恢复、会话隔离、停止、上游错误落库前脱敏、在途暂停恢复，以及失败 / 停止后 Continue、Continue 幂等、不重复用户 Entry 和拒绝空 / 已回答 / 忙会话。
- `pnpm run build`：通过。
- 页面回归：9 项通过；新增超时重试去重、会话切换的迟到状态保护、生成刷新与历史分页竞态覆盖，以及停止后继续、继续结果未知时沿用同一 ID 重试、草稿保留；原服务商测试全部通过。
- `cargo fmt --check`、`cargo test`：通过，10 项 Rust 测试及 main / doc tests 均通过。
- 真实 `pnpm tauri dev`：在独立应用标识、独立数据目录和独立凭据命名空间中配置本地模型，完成两轮对话。第二次请求包含先前助手回复，输出预算为 2048，认证正确。
- 真实桌面验证慢速生成中途停止、401 错误不显示或持久化合成 Key、重启后历史与模型恢复；已完成会话无额外模型调用。
- 补充真实桌面 Continue 验收：停止后继续保留未发送草稿；401 失败后正常关闭、重启，原模型与继续入口恢复。四次本地调用中的用户消息数依次为 1、1、2、2，最终只有两条用户 Entry；认证与 2048 输出上限均正确。
- 验收后删除合成 Key 与自定义配置，独立凭据命名空间剩余 0 项。保留独立测试数据库中的合成聊天记录，不触碰正式应用数据。
- `git diff --check`：通过。

模型网络请求全部连接本地模拟服务器，无外部付费调用。首次恢复测试的错误假设和后续验证结果如上记录。

已获用户授权并合并提交、推送：`e5e8697 feat(chat): 支持持久化模型对话与生成控制`。
