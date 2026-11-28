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
- 服务商返回的思考内容可折叠查看，生成状态区分思考与回复；遮蔽内容不展示，普通模型不显示空面板。
- 已完成回复下方显示原生请求耗时和服务商报告的输出 token；缺失的统计项不显示。
- 勾选“沙箱计算”，助手可运行 Python 或 JavaScript，查看折叠代码和计算结果；计算与数据分析优先使用 Python。每次执行限时 3 秒，Python WASM 内存 256 MiB、JavaScript 内存 32 MiB，每次发送最多三轮模型请求。脚本无法访问本机文件、终端、网络或服务商凭据，普通聊天默认关闭此工具。
- Python 使用随依赖提供的 CPython 3.11.3 / WASI，支持 math、statistics、csv、json 等标准库；每次执行独立，使用 print 返回结果。不需要系统 Python 或 Docker；当前不包含 NumPy / pandas，也不开放安装包和文件写入。
- “工作区”通过系统对话框选择目录，支持目录浏览、筛选和只读文件预览。当前限 UTF-8 文本 / 代码、单文件 64 KiB、每目录最多 200 项；预览内容不会自动发送给模型，重启需重新选择目录。
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

当前支持文本聊天与隔离 Python / JavaScript 计算，尚不向 Agent 开放文件或终端工具，也未实现 Router / Worker 自主工作流。计算沙箱不等于本机 Shell 的操作系统隔离，未来文件写入和命令执行仍需独立授权与隔离。架构边界见 [ADR-0001](docs/architecture/0001-runtime-boundaries.md)，逐步实现与验证记录见 docs/development。
