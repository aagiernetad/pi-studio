# V0.3.5：会话标题整理

日期：2026-11-24。基于本地已提交的 `ca0473c feat(chat): 支持 Markdown 渲染与消息复制`。

## 核查与范围

重新阅读 ADR-0001、当前 Git 状态、会话索引、Handler、Rust Commands、React 会话面板及对应测试。已有索引保存 title，但创建后没有修改入口，列表不支持标题搜索。本阶段只补齐重命名和搜索，不新建存储、执行层或索引副本。

- conversation.rename 在已有 Durable Session Document 的同一事务内更新标题，返回原 ID、创建时间及新标题。严格检查用户会话可见性与参数；Root / 内部会话不可修改。事务写入前检查取消信号。
- 重试相同目标标题是幂等的设置操作。不同客户端同时修改时，以最后成功提交的标题为准；没有引入新请求表或版本实体。
- conversation.list 增加可选 query。先在全部用户会话标题中进行不区分大小写的字面子串筛选，再按已有 ID 顺序分页；不传 query 的现有调用保持原行为。
- 原有标题字段与索引形状不变，不迁移数据库，不改变原生 Conversation / Agent / Transcript 或创建请求幂等键。
- Rust 仍只转发现有 JSONL IPC；React 增加搜索表单和会话标题编辑器。更新标题不重新挂载同一会话聊天组件，保留未发送草稿。
- 列表请求按搜索条件取消过期结果，分页记住加载代次；切换搜索后旧分页不能混入新列表。保存标题时锁定列表刷新、搜索和创建，但允许切换会话，迟到保存结果不会覆盖新会话。
- 保存结果未知时显示通用提示，可重试相同标题或刷新核对；不显示底层原始错误。重命名后若不再匹配当前搜索，只移出搜索结果，不删除会话，并显示说明。

## 修改文件

- runtime/src/durable/conversations.ts、conversation-handlers.ts：复用会话索引增加标题更新和查询过滤。
- src-tauri/src/lib.rs：可选查询参数与重命名转发命令。
- src/ConversationPanel.tsx、src/ConversationTitleEditor.tsx：标题编辑、搜索与异步保护。
- runtime/src/durable/conversation-handlers.test.ts、tests/provider-settings.test.mjs：持久化、分页、可见性、幂等与异步竞态回归。

## 验收

- runtime:typecheck：通过。
- runtime:test：75 项通过，0 失败 / 取消 / 跳过。首次全量运行中旧的本地连接测试超时，停止同时运行的类型检查与构建后全量重跑通过；没有放宽请求超时或修改原测试。
- build：通过。
- 页面回归：14 项通过，原 11 项与新增 3 项均通过。
- cargo fmt --check、cargo test：通过；10 项 Rust 测试及 main / doc tests 均通过。
- 真实 pnpm tauri dev：复用独立验收目录中的合成聊天历史，重命名后逐项比较 Transcript 保持一致；增加 20 个合成空会话后，第一页显示 20 条，标题搜索找到第 21 条旧会话。修改标题使其移出当前搜索后，清除搜索并加载下一页仍可找到。
- 正常关闭、重启真实桌面后，新标题、原 Conversation ID、原 Transcript 和 Markdown 渲染均保留，标题搜索正常。全程无模型请求或新凭据；独立凭据命名空间保持 0 项。
- 测试窗口已正常关闭，正式应用数据未触碰。git diff --check 通过。

已获用户授权并提交、推送：`13fcf16 feat(conversation): 支持会话重命名与标题搜索`。
