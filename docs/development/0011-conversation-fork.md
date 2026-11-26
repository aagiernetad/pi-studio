# V0.3.8：从助手回复处分支会话

日期：2026-11-26。基于已推送的 `0c84d2b feat(context): 重置会话上下文并保留历史`。

## 核查与范围

实施前复核 ADR-0001、当前工作区、现有会话索引 / Transcript / RuntimeClient 及已安装 Pi Durable 1.5.0。原生 Conversation.fork 内部调用事务的 tx.forkConversation；本轮直接在同一 Harness Commit 中调用该原生接口并登记既有 Studio 会话索引，保持创建与登记原子性。

- 新增 conversation.fork（Tauri: conversation_fork），仅接受可见会话 ID、已完成助手回复 Entry ID 与 UUID。按原生 fork-aware 范围查询精确校验 Entry，拒绝隐藏会话、其他会话记录、父会话分支点之后的记录及中断 / 错误回复。
- 复用 Studio 已有请求索引；同一请求并发或重启后重试返回同一分支，不重复创建。创建与分支操作、不同来源 / Entry 不可混用同一 UUID。写入前检查 AbortSignal。
- 使用原生 ownerless 历史分支。模型 / 上下文按原生文档分支规则继承，Live / Inbox / Provider / Usage 使用原生初始化。创建分支不调用模型、不需要凭据、不启动任务，也不干扰原会话正在进行的生成。
- 既有用户会话索引增加可选 forkedFrom 来源元数据，老会话无需迁移。自动标题为原标题截断后加“（分支）”，最大 120 字符；仍可使用现有重命名与搜索。重命名保留来源。
- Transcript 的完整助手回复下提供“从此处新建分支会话”。成功后选中新会话、清除标题搜索并刷新列表。来源会话与回复编号可见；分支用量仅累计分支自己的新请求，不复制原会话费用。
- 未确认结果保留同一 UUID、禁用其他分支入口并提供同请求重试；错误不回显底层细节。原会话切换后迟到的创建结果不能改变新选择或草稿。列表、Transcript 原有分页及异步保护保留。
- 本轮未增加消息编辑、删除、自动重生成、树形分支浏览或 Router / Worker；未新增数据库、Agent Loop、Scheduler 或 Checkpoint。

## 修改文件

- runtime/src/durable/conversations.ts、conversation-handlers.ts：原生分支、索引登记、参数与可见性校验、请求幂等。
- runtime/src/durable/chat.test.ts：沿用真实 SQLite 与本地 SSE 模型夹具，增加 3 项分支回归。
- src-tauri/src/lib.rs：通过既有 RuntimeClient 转发命令。
- src/ConversationPanel.tsx、ConversationTranscript.tsx：分支按钮、重试、来源提示与选中会话保护。
- tests/provider-settings.test.mjs：增加丢失响应重试、分支选中及迟到结果保护的 2 项界面回归。

## 验收

- runtime:typecheck、build：通过。
- runtime:test：83 项通过，无失败 / 取消 / 跳过。覆盖并发与重启去重、无凭据分支、完整历史 / 模型继承、独立用量、真实模型请求排除后续消息、原会话数据不变、隐藏 / 外部 Entry / UUID 冲突拒绝、嵌套分支及原会话运行互不影响。
- 页面回归：20 项通过，原有 18 项与新增 2 项均通过。
- cargo fmt --check、cargo test：通过，10 项 Rust 测试及 main / doc tests 均通过。
- 真实 pnpm tauri dev：使用既有独立测试应用 / 数据 / 凭据命名空间及本地 SSE 模型，源会话两轮聊天 4 条 Entry、累计 34 token。从第一条助手回复分支后仅继承截至该处的 2 条 Entry，模型选择保留，Usage 为空，模型调用仍为 2 次。
- 正常关闭重启后，分支来源、历史和模型均恢复。分支新请求包含此前用户标记及分支新问题，不包含原会话分支点之后的标记；共 2 条用户消息。该轮后分支为 17 token，原会话仍为原来的 4 条 Entry 和 34 token，未出现分支问题。无外部付费调用。
- 通过设置界面删除测试服务商及合成 Key；独立凭据命名空间剩余 0 项。测试桌面正常退出，Runtime 输出 JSONL Server stopped / DurableHost closed；本地模型已关闭。正式应用数据与会话未触碰。git diff --check 通过。

已于 2026-11-26 经用户授权提交并推送：`0ad281e feat(conversation): 从助手回复分支新建会话`。
