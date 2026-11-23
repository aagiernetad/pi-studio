# V0.3.2-A1：统一 Models 实例

验收日期：2026-11-23

## 接手时的实际状态

- 分支 `main`，起点提交 `30f64fe`（V0.3.1 桌面会话管理与历史分页）。
- `runtime/src/durable/host.ts` 已有未提交的 A1 实现：调用一次 `builtinModels()`，将同一集合传给 `Harness.open()` 并暴露为 `host.models`。
- `runtime/src/durable/host.test.ts` 已有目录读取测试。本次保留原实现，补强回归覆盖后验收。
- `AGENTS.md`、`PI_STUDIO_CODEX_HANDOFF.md` 是接手时已有的未跟踪文件，未纳入本次 A1 提交。

## 架构与依赖核查

已完整阅读交接文件与 [ADR-0001](../architecture/0001-runtime-boundaries.md)，并核查 Node Composition Root、Conversation / Entries、Handler Registry、JSONL Server、Rust Supervisor / Commands、React 会话与 Transcript 组件及现有测试。

运行链路保持 React → Tauri Commands / Events → Rust RuntimeClient → JSONL IPC V1 → Node Runtime → Pi Durable / SQLite。Node 继续独占 Durable Storage；执行、调度、Checkpoint 与恢复继续由 Pi Durable 管理。DeepSeek Super-agent 的业务实体与 Durable 执行实体保持各自职责，pi-harness 仅作为产品工程参考。

以已安装包的类型定义与实现为依据：

- `@earendil-works/pi-ai`、`pi-durable`、`chord` 均为 `1.5.0`，没有升级依赖。
- `createModels()` 返回空的 `MutableModels`；`builtinModels(options?)` 创建集合并注册内置 Provider，同样返回 `MutableModels`。
- `HarnessOptions.models` 接受 `Models` 或返回 `Models` 的函数；现有 Host 直接传入集合即可，无需额外 Registry 或管理类。
- Harness 内部会为请求身份包装 Models 访问，并委托给传入的集合；这不构成第二套 Provider Registry。
- 默认凭据与动态目录存储为内存实现。本阶段只读取内置目录，不调用认证、刷新或推理接口，也不接入持久化 Credential Store。

## 最小变更

- `runtime/src/durable/host.ts`：保留接手时已有的共享集合实现，作为 A1 一并提交。
- `runtime/src/durable/host.test.ts`：在真实 Harness / 临时 SQLite 上记录 `Harness.open()` 调用，断言只打开一次且收到的 Models 与 `host.models` 为同一引用；验证 DeepSeek、OpenAI、Anthropic 的 Provider、非空模型目录、模型归属及逐模型查询；保留 Root Conversation 可用性检查。
- 本记录：保存实际核查、变更范围、验证结果与后续边界。

IPC、Rust、React、数据库结构和依赖版本均未修改；保留原有会话切换、异步取消及分页保护。所有持久化测试使用临时目录，没有读取或修改用户应用数据库。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `pnpm run runtime:typecheck` | 通过 |
| `pnpm run runtime:test` | 40 项通过，0 失败、0 跳过 |
| `pnpm run build` | TypeScript 与 Vite 构建通过 |
| `cargo fmt --check`（`src-tauri`） | 通过 |
| `cargo test`（`src-tauri`） | 10 项通过，包含真实 Rust → Node JSONL IPC 与跨进程 SQLite 持久化；main / doc tests 均通过 |
| `git diff --check` | 通过 |

自动化检查未发现回归，覆盖独立 Conversation 持久化、跨重启创建去重、Transcript 分页与内部会话可见性、IPC 取消 / 超时 / 并发和 Runtime 关闭。

本次未执行 `pnpm tauri dev` 或真实桌面交互验收；未改动桌面端代码，构建与 Rust 集成测试通过不代表已重新验证桌面操作。

## 限制与下一步

内置目录存在不代表凭据可用、网络连通或模型可推理。A1 尚未提供 Provider IPC、Credential Store、自定义配置、设置页面或模型聊天，也未引入 Router / Worker。

下一最小阶段为 A2：在现有 Handler Registry 上实现只读 `provider.list` / `model.list`，直接复用 `host.models`，经用户确认后开始。安全凭据存储应另行技术验证；不能将 `qwen-token-plan-cn` 视为通用 DashScope Provider。

本阶段仅做本地 Git 提交；远程推送前需获得用户授权。
