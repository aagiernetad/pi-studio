# V0.3.7：保留历史重置会话上下文

日期：2026-11-25。基于已推送的 `b680def feat(usage): 展示会话模型用量与参考费用`。

## 核查与范围

实施前重新阅读 ADR-0001、当前 Git 状态、聊天 Handler / React 状态、Transcript、已安装 Pi Durable 1.5.0 的 reset / Submission / 上下文实现。原生 Conversation.reset 使用 pi.reset 被动 Entry 和 head: self，旧 Entry 不删除。本轮复用该机制，只补充 Studio 用户入口、原生 requestId 去重和异步保护。

- conversation.context.reset 严格校验 Conversation ID 与 UUID，检查 Studio 可见性；Root / 内部会话不可访问。事务内先检查原生 submissionByRequest，重试同一重置返回原提交。
- 无重复请求时，原生 LiveDoc / InboxDoc 中存在运行、压缩或排队工作即拒绝重置；写入前检查 AbortSignal。空闲时以原生 type: write 提交 pi.reset / head: self，附加原生 requestId。没有自建任务、调度、Checkpoint、请求表或消息副本。
- 重置本身不鉴权、不调用模型；原 ID、标题、模型配置、历史和 UsageDoc 均保留。下一条普通输入从新的原生上下文开始，旧消息仍可在 Transcript 查看。
- 普通输入 / Continue / Reset 的 requestId 不可混用。旧输入的幂等键也仍有效，重试不会把旧消息送入新上下文。
- 返回已完成原生写入的 Entry ID。React 以该 ID 忽略重置前迟到的状态快照；不会让旧失败状态短暂恢复为“继续上次生成”。
- 原生旧 runFailure 留作执行事实。状态展示和继续准入以最新 pi.reset Entry 为边界，不删除原生失败记录；新边界上不能继续旧的失败上下文。
- React 先说明影响，再要求点击确认。重置时保留当前输入框草稿与模型选择；未知结果保留同一 UUID、锁定其他提交并提供重试，通用错误不回显底层细节。切换会话后，迟到结果不能覆盖新会话或草稿。
- Transcript 将原生 pi.reset 显示为“新上下文”边界。未增加任何自动重置或历史删除；草稿保留只指本次重置，页面关闭后的草稿行为与此前相同。

## 修改文件

- runtime/src/durable/chat-handlers.ts、chat.test.ts：原生 Reset 写入、可见性 / 幂等 / 忙碌保护与真实模型上下文回归。
- src-tauri/src/lib.rs：原有 RuntimeClient 转发新命令。
- src/ConversationChat.tsx、ConversationTranscript.tsx：确认、重试、状态保护和历史边界显示。
- tests/provider-settings.test.mjs：沿用原页面回归增加确认、超时重试、草稿及迟到状态保护。

## 验收

- runtime:typecheck、build：通过。
- runtime:test：80 项通过，无失败 / 取消 / 跳过。包括原生重置并发去重、跨重启重试、历史 / 模型 / 用量保留、无凭据重置、后续真实本地模型请求不含旧消息、忙碌 / 无效 / 隐藏请求拒绝，以及旧失败上下文不可继续。
- 页面回归：18 项通过，原有 16 项与新增 2 项均通过。
- cargo fmt --check、cargo test：通过，10 项 Rust 测试及 main / doc tests 均通过。
- 真实 pnpm tauri dev：在独立测试应用 / 数据 / 凭据命名空间中完成一轮本地聊天，确认重置后旧消息、模型、17 token 累计用量和当前草稿保留；只出现一个原生 pi.reset，模型调用仍为一次。
- 正常关闭重启后仍显示上下文边界和原模型。新问题的真实上游请求只有一条新用户消息，不含旧用户标记或旧助手内容；旧消息仍在 Transcript，累计用量增至 34。模型调用共两次，没有外部付费请求。
- 合成 Key 和自定义配置均已删除，独立凭据命名空间剩余 0 项，测试桌面及本地模型已正常关闭。正式会话数据未触碰。git diff --check 通过。

已于 2026-11-26 经用户授权提交并推送：`0c84d2b feat(context): 重置会话上下文并保留历史`。
