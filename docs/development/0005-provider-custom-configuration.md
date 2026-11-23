# V0.3.2-D1：自定义服务商与模型配置

开发与验收日期：2026-11-24。本轮在服务商设置与模型连接测试基础上继续实施；用户确认将两轮合并为同一个提交，基于 `3c3cabf` 交付。

## 实际功能

在既有服务商设置中增加“自定义配置”：新建、编辑、删除一个 OpenAI 兼容 Chat Completions 服务商及其文本模型。保存后自动选择该服务商，继续使用已有密码框设置 API Key、显式测试连接；重启 Runtime 后恢复配置。

本次只支持每个配置一个文本模型及一种协议，不增加模型发现、内置服务商覆盖、聊天、Router / Worker、OAuth 或额外请求头配置。

## 复用和数据边界

实施前重新阅读 ADR-0001、Host、已有 Conversation 应用索引、配置与凭据 Handler、Rust RuntimeClient、React 设置页和安装的 `pi-ai@1.5.0` 源码。

- 使用原生 `createProvider`、`envApiKeyAuth`、`openAICompletionsApi` 和唯一 Models 的 `setProvider/deleteProvider`，不重建协议客户端、Provider Registry 或 Agent 执行逻辑。
- 非敏感配置沿用现有应用索引的 `defineDoc` Session Document 方式，文档名 `studio.provider-settings`、版本 1。由 Node 应用层写入，后端仍是原有 Durable Storage，不增加数据库或文件镜像。
- Host 在 `harness.resume()` 前恢复配置并注册到同一个 Models；Harness 与目录、连接测试始终共享该集合。
- 配置写入与发布串行执行，持久化失败不替换当前 Provider；失败后队列可继续处理下一次保存。
- 凭据保持现有独立系统存储。配置不接受 Key、headers 或任意 SDK 参数，事件只包含服务商 ID。

## IPC 和输入约束

新增 `provider.config.list`、`provider.config.set`、`provider.config.delete`，通过同名含下划线的 Tauri Commands 调用，复用原有 JSONL IPC V1 和 RuntimeClient。

`set` 参数：`{ id, name, baseUrl, modelId, contextWindow, maxTokens }`，严格拒绝多余字段；Tauri 入口接受 `{ config: 参数对象 }` 并原样转发。

- ID 必须符合 `custom-[a-z0-9][a-z0-9-]{0,55}`，与内置服务商分离；同一 ID 保存为更新，编辑已有配置时界面锁定 ID。
- 最多保存 32 个配置；名称最多 80 字符、模型 ID 最多 256 字符、地址最多 2048 字符。
- 远程地址使用 HTTPS；HTTP 仅允许精确的 `localhost`、`127.0.0.1`、`[::1]` 回环地址。禁止 URL 用户名、密码、查询参数和 fragment；保存时规范化末尾斜线。
- 上下文窗口为 128–10,000,000，最大输出为 16–1,000,000 且不超过上下文窗口。表单说明基础地址不含 `/chat/completions`。
- 用户填写的模型能力属于手动声明，不保证上游能力匹配；当前不展示自定义模型价格，Pi AI 所需 cost 字段为零占位，不作为收费承诺。

保存配置不联网，也不操作凭据。显式连接测试继续使用既有固定短请求、16 token 输出预算、8 秒超时、不重试、不跟随重定向的约束。

修改端点会改变已有 Key 的发送目标，界面明确说明这一点。删除按钮明确为“删除配置（保留凭据）”；需要清除密钥时，应先在“密钥与连接”中删除凭据，再删除配置。重新创建相同 ID 会重新关联该 ID 的已有凭据。

## 界面和恢复保护

自定义配置与密钥编辑分别显示，切换时卸载旧编辑器，避免残留未提交密码。保存 / 删除期间禁用模式切换与重复提交，收起再展开保持正在进行的操作。未知原始异常不回显；结果不明确时需要刷新配置。加载结果带卸载保护。

既有 Conversation、Transcript 分页及其异步保护未修改。

## 验证记录

- `pnpm run runtime:typecheck`：通过。
- `pnpm run runtime:test`：65 项通过，含配置恢复、内置目录保护、拒绝敏感字段与不安全 URL、串行更新、取消 / 提交失败不发布、本地 HTTP/SSE 调用，以及正式 Runtime 的新增方法注册验证。
- `pnpm run build`：通过。
- 页面测试：5 项通过，包含自定义配置新建、编辑、删除接入目录及凭据保留；已有密钥与异步保护测试全部通过。
- `cargo fmt --check`、`cargo test`：通过，10 项 Rust 测试及 main / doc tests 均通过。
- 真实 `pnpm tauri dev`：通过表单创建自定义服务商和模型、保存合成 Key、点击连接测试。本地服务确认请求路径 `/v1/chat/completions`、模型 ID、认证与 16 token 上限正确。
- 正常关闭后重启桌面，配置、模型与系统凭据恢复，密码框不回填；再次本地连接成功。验收后先删除合成 Key，再删除配置，确认独立凭据命名空间和配置列表均为 0。
- `git diff --check`：通过。

所有模型请求仅使用本地测试服务器和合成凭据，没有调用外部付费模型。测试使用独立临时数据目录，桌面验收使用独立应用标识和独立凭据命名空间。

桌面首次链接因上一轮隔离窗口仍占用程序文件而失败；确认窗口归属后正常关闭，再次启动通过。没有修改权限或覆盖正在运行的程序文件。桌面自动化通过 Win32 正常关闭测试窗口，没有为测试扩展正式应用的 Tauri 权限。

合并提交名称：`feat(provider): 支持服务商与模型配置管理`。用户已确认两轮合并提交并推送。
