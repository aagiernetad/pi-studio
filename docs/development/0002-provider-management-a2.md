# V0.3.2-A2：只读 Provider / Model 目录 IPC

验收日期：2026-11-23。起点提交：`dedb166`（A1 统一 Models 实例，提交说明改为中文后的哈希）。

## 实施前核查与范围

重新阅读 [ADR-0001](../architecture/0001-runtime-boundaries.md)，核查本地 Git、已安装 `pi-ai@1.5.0` 类型、Host、Runtime 入口、Handler Registry、Dispatcher 和现有参数校验 / IPC 测试。A1 已提供 `host.models`，A2 开始前尚无 Provider Handler。

本次直接将 `durableHost.models` 注入现有 Registry 中的两个只读 Handler。没有新增 Provider Registry、管理类、数据库、模型协议客户端或执行层，也没有升级依赖、修改 Rust / React 或接入凭据存储。

## 接口契约

沿用 JSONL IPC V1 请求与响应封装：

| 方法 | params | 成功 result |
| --- | --- | --- |
| `provider.list` | `{}` | `{ items: [{ id, name }] }` |
| `model.list` | `{ providerId: string }` | `{ items: [{ id, name, provider, api, reasoning, input, contextWindow, maxTokens }] }` |

- 列表按 `id` 排序；每次请求读取同一 Models 的当前集合，不缓存第二份目录。
- `model.list` 只返回指定 Provider 的本地已知聊天模型目录，不返回图片或分类模型，不解析凭据、不刷新网络目录。动态 Provider 尚无目录时可返回空列表。
- `providerId` 去除首尾空白后必须为 1–128 个字符。额外字段、缺少必填参数、类型错误等返回 `INVALID_PARAMS`；未知 Provider 返回 `PROVIDER_NOT_FOUND`。
- 响应只选择上述字段，不返回 Provider / Model 原始对象、headers、endpoint、auth 实现或认证状态。目录存在不意味着认证或推理可用。
- 沿用 Conversation IPC 的 512 KiB 响应预算，超出返回 `RESPONSE_TOO_LARGE`；本阶段不提供目录分页。

## 修改文件

- `runtime/src/handlers/providers.ts`：只读目录、严格参数校验、字段选择与响应大小检查。
- `runtime/src/index.ts`：通过现有 Composition Root 注册 Handler，注入 `durableHost.models`。
- `runtime/src/handlers/providers.test.ts`：新增五项回归与集成测试。
- 本开发记录。

## 验证

新增测试覆盖内置 Provider / 模型查询、禁止认证 / 刷新 / 推理调用、注册后的集合变化、空目录与未知 Provider 区分、字段白名单、非法参数、响应大小，以及独立 Node Runtime 进程的真实 JSONL IPC。集成测试使用临时数据库，并确认既有 `runtime.ping` 仍可用。

| 检查 | 结果 |
| --- | --- |
| `pnpm run runtime:typecheck` | 通过 |
| `pnpm run runtime:test` | 45 项通过，0 失败、0 跳过 |
| `pnpm run build` | 通过 |
| `cargo fmt --check`（`src-tauri`） | 通过 |
| `cargo test`（`src-tauri`） | 10 项通过，main / doc tests 均通过；包含真实 JSONL IPC 与 Runtime 重启持久化 |
| `git diff --check` | 通过 |

自动化检查未发现 Conversation、Transcript、IPC 或持久化回归。用户应用数据库未被读取或修改；`AGENTS.md` 和交接文件保持原有未跟踪状态。

本次未新增 Tauri Commands 或设置页面，尚不能从桌面 UI 调用这些新方法；未执行 `pnpm tauri dev`，也未验证模型推理。下一步先验收目录契约，再确定后续安全凭据存储验证的范围。

## Git 审核约定

本阶段最终提交：`3f814d1 feat(provider): 支持查询服务商和模型列表`。已向用户展示并获得确认，随后与 A1 一并推送 GitHub。后续提交使用中文描述实际功能，推送前仍需向用户展示具体名称与哈希并获得确认。
