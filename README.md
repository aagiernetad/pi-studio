# Pi Studio

基于 React、Tauri、Node Runtime 与 Pi Durable 的本地优先桌面工作台。

当前可以管理服务商和模型凭据，进行持久化文本对话、停止和继续生成、阅读 Markdown 与代码、搜索和重命名会话、查看用量、重置上下文及从回复创建分支。切换会话可保留本次打开期间的草稿和未确认发送请求。

## 启动桌面

在已配置 Node、pnpm、Rust 和 Tauri 开发依赖的环境中：

~~~sh
pnpm install
pnpm tauri dev
~~~

进入“服务商”，使用内置目录，或添加 OpenAI 兼容服务商配置。保存 API Key 后测试连接；回到“会话”，新建会话并选择模型即可发送。密钥保存在 Windows 系统凭据管理器，配置与 Transcript 不保存 API Key。

- 左侧列表可搜索、切换和新建会话，右侧消息区独立滚动，输入区保持可见。
- Ctrl / Command + Enter 发送，Enter 换行；输入法组合确认不会发送。
- “详情与用量”查看会话信息和原生累计用量；输入区试管显示上次已完成请求的输入占比，点击查看缓存明细，不计未发送草稿。
- “查看模型内容”查看单条原始内容。
- 窄窗口通过“会话列表”切换列表和对话。
- “外观”提供四套主题、强调色、圆角、阅读宽度、代码字体与导入 / 导出；右上角可快速切换明暗。
- 点击输入区模型胶囊搜索模型、切换服务商，并按模型原生支持调整推理强度。长代码可手动折叠，复制始终保留完整代码。
- “大纲”搜索当前已加载问题，沿分页加载更早问题；Alt + ↑ / ↓ 可跳转问题，输入时不接管快捷键。
- 草稿只在本次打开期间保留。生成中退出后，未完成请求可能在重启恢复并再次调用模型；需要结束时先停止生成。

## 验证

~~~sh
pnpm run runtime:typecheck
pnpm run runtime:test
pnpm run build
pnpm run ui:test
~~~

页面回归使用 Playwright，需要可用的 Chromium 浏览器；也可设置 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 指向已有的兼容浏览器。Rust 检查在 src-tauri 目录执行 cargo fmt --check 和 cargo test。

## 架构与范围

React → Tauri Rust commands/events → JSONL IPC V1 → Node Runtime → Pi Durable / SQLite。Node 是 Durable Storage 的唯一所有者，Pi Durable 负责执行、调度、Checkpoint 与恢复。服务商和 Harness 共享一套 Models。

当前为文本聊天工作台，尚不执行文件或终端工具，也未实现 Router / Worker 自主工作流。架构边界见 [ADR-0001](docs/architecture/0001-runtime-boundaries.md)，逐步实现与验证记录见 docs/development。
