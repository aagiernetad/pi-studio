# V0.3.4：聊天内容阅读与复制

日期：2026-11-24。上一里程碑已推送：`e5e8697 feat(chat): 支持持久化模型对话与生成控制`。

## 范围与架构

实施前重新阅读 ADR-0001、Git 状态及已有 Transcript、聊天组件和页面回归。现有能力已经覆盖文本生成、停止、继续和恢复；本轮补齐生成结果的阅读与复制。

- 新增 ChatMessage，使用 react-markdown 10.1.0 与 remark-gfm 4.0.1 渲染助手的已落盘回复：标题、列表、引用、表格、行内代码及代码块。
- 用户消息保留原文显示；非聊天 Entry 与原有模型详情继续使用原展示方式。生成中的临时正文保持纯文本。
- 可复制原始消息 / 回复及单独代码块，保留代码换行。复制失败显示通用提示，允许手动复制；异步结果不更新已卸载组件。
- 不执行原始 HTML，不自动请求模型提供的图片；只允许 HTTP / HTTPS 链接，并通过已有 Tauri opener 在系统浏览器打开。没有添加执行代码、文件读取或工具权限。
- 仅改变 React 展示，不修改 Node、Rust、SQLite、Durable 模型或会话数据。继续沿用原有会话切换与分页异步保护。

## 修改文件

- src/ChatMessage.tsx：Markdown、代码块、复制与链接展示。
- src/ConversationTranscript.tsx、src/App.css：接入已有历史面板并增加局部样式。
- package.json、pnpm-lock.yaml：新增两个前端渲染依赖。
- tests/provider-settings.test.mjs：复用现有真实浏览器测试，覆盖富文本、复制原文 / 代码、复制失败及不可信内容边界，保留原有服务商与聊天回归。

## 验收

- pnpm run runtime:typecheck：通过。
- pnpm run runtime:test：73 项通过，无失败、取消或跳过。
- pnpm run build：通过。
- 页面回归：11 项通过，包含原有 9 项和本轮新增 2 项。
- 真实 pnpm tauri dev：使用独立应用标识 / 数据目录 / 凭据命名空间与本地模拟模型，验证标题、表格、代码和图片占位；复制代码与完整回复后直接核验 Windows 原生剪贴板，CRLF 归一化后与原文一致。重新加载仍可显示历史，原生 Entry 中的回复原文未改变。模型调用共一次，没有外部付费请求。
- 清理合成 Key 与自定义配置后，独立凭据命名空间剩余 0 项；测试窗口和本地模型已正常关闭，正式会话数据未触碰。
- 本轮未修改 Rust。git diff --check 通过。

已获用户授权并提交：`ca0473c feat(chat): 支持 Markdown 渲染与消息复制`。本地提交完成，尚未推送。
