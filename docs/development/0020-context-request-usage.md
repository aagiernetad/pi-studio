# 输入区上下文试管：上次请求的真实用量

日期：2026-11-26。基于本地工作区继续接入，开始前重新阅读 ADR-0001。

## 数据口径与范围

已安装的 pi-durable / pi-ai 为 1.5.0。核对 Conversation.context、ContextView、原生 context 派生逻辑、estimateContext / estimateContextTokens 和 Usage 类型后确认：有效消息视图能正确处理 reset、fork、edits 及失败回复排除；下一次请求的精确 token 不能从累计 Usage 或文本长度获得。

因此，本轮只展示“上次已完成请求的输入”占其模型目录窗口的比例，不声称是当前完整上下文或下一次请求的精确占用，不把估算值包装为测量值。

- 输入为 pi-ai 标准化 input + cacheRead + cacheWrite；reasoning 是 output 的子集，不重复相加。
- 使用有效上下文中的最后一条助手回复，不累加各轮用量；最新完成回复缺少有效输入用量时显示未报告，不退回旧读数或伪造 0%。
- 读取该回复所用模型的目录窗口。切换界面模型不改写历史记录；目录不可用时仍显示 token 明细，但没有百分比。
- 正 token 的极小比例显示 <0.1%，避免四舍五入成空上下文。
- 重置后清除旧读数，原历史和累计用量保留。分支可读取其继承的有效历史，累计账本仍独立。

## 接入与修改

- runtime/src/durable/conversation-handlers.ts：新增 conversation.context.usage 只读投影，复用用户可见性、Durable context 和共享 Models。只返回公开计数，不访问认证、调用模型或写数据。
- src-tauri/src/lib.rs：增加 conversation_context_usage 命令，复用现有 RuntimeClient 和 JSONL 传输，不访问数据库。
- src/ConversationContextUsage.tsx：输入区试管与用量弹层，展示输入、输出、缓存、推理明细；错误可重试；旧页和迟到结果隔离。
- src/ConversationChat.tsx / workspace.css：接入试管、临界占用提示与明暗 / 窄窗布局。弹层中的开始新上下文仍进入原确认流程，忙碌或有未确认请求时禁止重置。
- 只在会话、最新 Entry、重置或目录版本变化时读取，及用户手动刷新时读取；不在一秒生成状态轮询中重复扫描上下文，不另建缓存管理器或账本。
- 更新对应 Runtime / 页面测试及 README；没有变更包版本、存储格式或凭据方式。

## 验证

- runtime:typecheck、91 项 runtime:test、build 通过。
- 60 项页面回归通过；极小比例显示修正后的对应回归再次通过。覆盖原 55 项及真实读数、缓存口径、未报告 / 缺目录、错误重试、草稿与模型选择独立性、不重复轮询、迟到隔离、重置确认、忙碌禁用和明暗窄窗操作。
- cargo fmt --check 通过。cargo test 首次为 9 通过、1 个现有并发测试发生 10 秒 IPC 超时；整套重跑后 10 项全部通过，未修改生产超时或放宽断言。此次首轮同时发生桌面重编译与其他测试启动，环境竞争是可能原因，尚未证明。
- 真实 JSONL 测试补查新方法的参数和隐藏会话保护。增加请求后，原批量发送超过 8 个并发限制而得到 SERVER_BUSY；将该路由测试改为逐个发送并核对响应，保留生产并发上限及原断言。
- pnpm tauri dev 因 Rust 命令改动完成自动重编译，桌面进程和 DurableHost / JSONL Server 正常启动。
- 用独立夹具检查深浅主题截图，不读取正式会话，不用正式密钥，不向收费服务商发送验证请求。

## 发布复核

此前按用户要求暂停推送。用户随后明确授权使用 Xxevora 提交并推送现有实质功能；按运行时接口与前端工作台分为两次提交，不增加纯文档或凑次数的提交。作者和推送凭据均核验为 Xxevora，使用其 GitHub 隐私邮箱；不改写既有历史。AGENTS.md、PI_STUDIO_CODEX_HANDOFF.md 保持原样且不暂存。本记录与实际功能一起交付，不单独提交文档。

发布前重新读取 ADR-0001，拉取并确认本地主分支与远程一致。重新执行 runtime:typecheck、91 项 runtime:test、build、cargo fmt --check 和 10 项 cargo test，全部通过。页面测试首次因未安装默认 Playwright Chromium 无法启动，通过已有测试环境变量指定本机 Edge 后重跑；60 项页面测试全部通过，无失败、取消或跳过；测试断言和生产代码未为此放宽。

仍未实现下一次请求的精确上下文计量、自动压缩、宿主专有配额、像素伙伴、壁纸及文件执行功能。
