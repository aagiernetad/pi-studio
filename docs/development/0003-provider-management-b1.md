# V0.3.2-B1：安全保存服务商 API Key

验收日期：2026-11-23。起点：`3f814d1`，A1 / A2 已获用户确认并推送。

## 实际能力

Node Runtime 现可将服务商 API Key 保存到 Windows 凭据管理器、查询是否已保存、删除已保存凭据。重启后的 Models 可从同一系统存储解析认证信息；密钥不进入 Durable SQLite、普通设置或 Transcript。

实施前重新核查 [ADR-0001](../architecture/0001-runtime-boundaries.md)、真实 Git 状态和已安装 `pi-ai@1.5.0` 的 `CredentialStore`。复用其 `read` / `list` / `modify` / `delete` 协议，将同一凭据实例同时注入 Host 的 Models 和凭据 Handler，不另建认证 Registry 或模型客户端。

## 存储验证与选择

- 固定新增 Runtime 依赖 `@napi-rs/keyring@2.1.2`。核查安装包类型与[该版本错误转换源码](https://github.com/Brooooooklyn/keyring-node/blob/v2.1.2/src/result.rs)，确认缺失条目与原生失败有不同语义。
- Windows 实机使用独立测试服务名，验证缺失、保存、重新读取、列举与删除；正式回归还通过独立 Node 进程读取并由 Models 解析测试凭据。所有测试凭据均为合成数据并在结束后删除。
- 正式命名空间为 `com.pistudio.app.provider-credentials`，按 Provider ID 存储。采用普通 `AsyncEntry`，不使用构造时会写占位条目的 `withTarget`。
- 系统错误不带原始消息或 cause 向外传播；损坏凭据不会当成缺失，也不会静默覆盖。
- 按 Windows 凭据 Blob 的[官方限制](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw)，对序列化数据采用保守的 2560 字节预算（同时检查 UTF-8 与 UTF-16LE）。超限写入失败，原凭据保留。
- 原生模块延迟加载；本阶段仅验证并开放 Windows 系统存储，其他平台的凭据操作明确失败，不回退到明文文件或临时内存。

## IPC 契约

沿用 JSONL IPC V1 和现有 Registry / Dispatcher：

| 方法 | params | 成功 result |
| --- | --- | --- |
| `provider.credential.set` | `{ providerId, apiKey }` | `{ providerId, stored: true, type: "api_key" }` |
| `provider.credential.status` | `{ providerId }` | `{ providerId, stored, type }` |
| `provider.credential.delete` | `{ providerId }` | `{ providerId, stored: false, type: null }` |

`stored` 仅表示系统中存在记录，不表示模型连通或认证有效，也不包含环境变量配置情况。没有返回完整密钥、掩码、长度或其他凭据内容的接口。

参数严格校验；API Key 去掉首尾空白后要求 1–1024 个字符，拒绝内部空白、控制字符和额外字段。未知 Provider 返回 `PROVIDER_NOT_FOUND`，不支持 API Key 登录的 Provider 返回 `PROVIDER_API_KEY_UNSUPPORTED`，存储失败返回固定的 `CREDENTIAL_STORE_UNAVAILABLE`。更新 Key 保留原 API Key 凭据中的 Provider 环境配置。

保存与删除具有幂等效果，成功后只发出包含 Provider ID 和 `stored` 的 `provider.credential.changed` 事件。没有向日志、IPC 响应或事件写入密钥。原有 Handler 超时、取消和请求关联机制保持不变。

## 并发与限制

同一凭据实例内，`modify` 与 `delete` 按 Provider 串行；不同 Provider 可以并发。排队时和修改回调后检查取消信号。原生写入开始后等待完成再释放队列，避免已取消但尚未结束的原生写入越过后续操作。操作中途客户端超时仍可能已经写入，应通过状态查询或幂等重试确认。

Windows 凭据 API 没有由本适配器使用的跨进程读改写锁。本阶段仅支持单 Runtime 实例内的串行操作；OAuth 登录 / 自动刷新、多 Runtime 同时修改凭据需要后续验证，不能据此宣称已支持。

## 验证结果

- `pnpm run runtime:typecheck`：通过。
- `pnpm run runtime:test`：55 项通过，0 失败、0 跳过；覆盖真实 Windows 跨进程恢复、原生失败脱敏、串行修改与取消、Host 凭据注入、真实 JSONL 响应 / 事件 / 日志不回显 Key，以及原有 Conversation / Transcript 回归。
- `pnpm run build`：通过。
- `cargo fmt --check`、`cargo test`：通过，10 项 Rust 测试及 main / doc tests 均通过。
- `git diff --check`：通过。

本次没有改动 Rust、React 或 Durable 数据库结构，没有读取或修改用户应用数据库。测试、依赖锁文件和本记录随功能一起提交。

当前仍未提供桌面输入框、Tauri 凭据命令、自定义 endpoint、连通性验证或模型聊天；未执行 `pnpm tauri dev`。下一步验证自定义服务商配置与连通性接口，再接入设置页面。

本地提交名称：`feat(provider): 支持安全保存和删除服务商 API Key`。本阶段推送需另行获得用户确认。
