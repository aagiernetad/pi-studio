# 隔离 Python 计算工具

日期：2026-11-28。基于 796ec35，修改前重新阅读 ADR-0001。用户要求继续接入 Python 并推送；复用既有沙箱开关与 Durable 工具链，避免重复实体与非必要测试。

## 技术验证与边界

此前只有 QuickJS JavaScript。检查本机后确认 Docker 客户端存在但引擎未运行；不把启动 Docker 作为功能前提，也不直接执行系统 Python。

固定依赖 @runno/sandbox / @runno/wasi 0.10.3，使用包内 CPython 3.11.3 WASM 与标准库资源。核对其安装源码，使用 Runno 的纯内存 WASI 实现，未使用 node:wasi 或宿主目录挂载。可信启动代码只读固定包内资源；用户源码仅传给 WASM CPython。

- 在现有扩展中安装 python 工具，调用者仅允许 model，JavaScript 的 tools 列表仍不获得宿主能力。计算与数据分析优先 Python，用户明确要求 JavaScript 时仍可用原工具。
- 继续复用 conversation.chat.submit、原生 Tool Task、参数校验、requestId 幂等、停止、Transcript 与恢复。未添加 IPC 方法、Rust 命令、业务数据库、管理类或 Agent Loop。
- 每次调用使用全新可信 Node 子进程 / Worker / WASM，源码通过 stdin 发送，shell 未启用，子进程不继承宿主环境；不持久化 Python 变量。Python 启动使用 -I -S -B，不加载用户 site 或写字节码。
- 256 MiB WASM 内存上限由 V8 --wasm-max-mem-pages=4096 执行，另外限制 V8 old space 为 128 MiB；这不是整个进程 RSS 的硬上限。虚拟文件系统只含标准库，拒绝文件变更与非 stdout / stderr 写入，防止虚拟文件缓存绕开 WASM 上限。
- 每次执行限 3 秒，最多 16000 字符源码、12000 字节合并输出，超过即停止；结果继续受 Harness 的 16 KiB / 200 行限制。Runtime 和子进程各有 watchdog，WASM 在 Worker 中执行，宿主退出后子进程仍会自行结束。
- Python 与 JavaScript 共用现有最多两个执行名额；直到子进程实际关闭或 Worker 退出后释放。取消触发终止；宿主启动失败 / 超限只返回通用错误，原生诊断不进入历史或日志。
- 不授予本机文件、环境变量、网络、子进程、JavaScript 桥接或模型凭据。普通聊天仍默认关闭工具。页面复用现有组件，只按语言区分代码折叠项并按纯文本展示结果。

参考：[Runno 项目与 WASI 说明](https://github.com/taybenlor/runno)、[Python 官方 WASI 构建说明](https://devguide.python.org/getting-started/setup-building/)。实现以固定安装包源码和本地验证为准。

## 验证

新增两项 Python Runtime 集成，并扩充既有沙箱页面测试，不增加独立测试框架。覆盖真实本地模拟服务商 → Durable → Python → 最终回复，以及标准库计算、CSV / JSON、中文、本机文件与环境隔离、网络 / 进程 / JS 桥接拒绝、重启幂等和每次调用状态独立。

资源验证包含实际 512 MiB 分配触发 MemoryError、输出截断、死循环期限、原生停止及随后恢复计算；独立直接启动 runner，未配置父级 watchdog，仍以 124 退出，确认子进程自身期限有效。

runtime:typecheck、102 项 runtime:test、build 全部通过；71 项页面测试通过，无失败或跳过。未修改 Rust，仍执行 cargo fmt --check 和 cargo test -- --test-threads=1，11 项全部通过。明暗主题和 390px 窄窗的 Python 代码 / 结果预览已检查，临时夹具与图片不纳入仓库。

现有 pnpm tauri dev 窗口前端已热更新；Node 子进程需重新启动后才能加载新工具。为保留可能存在的内存草稿，未关闭当前窗口。所有用例使用临时数据与合成凭据，无正式会话、真实 API Key 或付费模型调用。

## 范围与后续

本轮仅提供标准库计算，不包含 NumPy / pandas、pip、本机 Python 包、文件上传或图表导出。WASM 资源固定为上游打包的 CPython 3.11.3；更新版本需重新核验兼容与隔离。依赖包包含额外语言资源，但没有对 Agent 暴露其他语言；后续发布打包应仅纳入所需 Python 资源。

下一步仍是当前会话对工作目录的显式只读授权；Python 文件输入、写入与 Shell 分别审核，不沿用当前计算权限直接放行。
