# V0.3.6：会话用量展示

日期：2026-11-25。基于已推送的 `13fcf16 feat(conversation): 支持会话重命名与标题搜索`。

## 核查与架构

实施前重新阅读 ADR-0001、当前 Git 状态、会话索引与 Handler、聊天状态、Transcript 及已安装 Pi Durable / Pi AI 1.5.0 的真实实现。Pi Durable 已有 UsageDoc，保存每个会话按模型累计的用量，包含有记录的失败 / 停止尝试。本轮直接投影原生账本，不新增计数器、表、历史重算或后台任务。

- conversation.usage 继续验证 Studio 用户会话可见性，只读原生 UsageDoc.models，不使用包含 Root / Worker 的 Session 全局总数。
- 按模型键排序、游标分页，默认 20、最多 50 行。只返回模型标识、公开 token 计数与参考美元费用，拒绝额外参数。不返回工具结果、消息正文、认证信息或原生对象的附加字段。
- token 必须为非负安全整数，否则返回 null；费用为有限正数才展示，零 / 负数 / 未知费用返回 null，避免把自定义模型的默认零定价显示成免费。
- 不重新相加输入、缓存或推理计数。直接使用原生 totalTokens；reasoning 是 output 的子集，只作为明细展示。费用来源可能是目录估算或服务商报告，统一标为参考费用，不承诺准确账单。
- 检查发现旧 chat-policy 在构造通用错误时将 usage 清零。本轮在脱敏的失败 / 停止终态中只复制经过校验的数值字段和布尔来源标记，保留已上报消耗，同时继续丢弃原始错误内容与扩展字段。没有上报或未保存的数据仍可能缺失。
- Rust 仅新增转发命令。React 复用现有聊天历史刷新标记，生成后重新读取累计用量；支持手动刷新与更多模型分页，切换会话及刷新后忽略迟到请求。不保存账本副本。

## 修改文件

- runtime/src/durable/conversation-handlers.ts：原生用量的只读分页 DTO。
- runtime/src/durable/chat-policy.ts、chat.test.ts：失败计数保留与原生执行回归。
- src-tauri/src/lib.rs：conversation_usage 转发。
- src/ConversationUsage.tsx、ConversationPanel.tsx、App.css：模型用量表、状态与异步保护。
- tests/provider-settings.test.mjs：沿用原页面回归增加用量显示、自动刷新、未知费用、分页与切换保护。

## 验收

- runtime:typecheck、build：通过。
- runtime:test：78 项通过，0 失败 / 取消 / 跳过。包括两轮真实本地 SSE 的原生累计、重复提交不重复计数、跨重启和会话隔离、只读查询不调用模型 / 凭据、51 个模型的分页与字段白名单、上报用量后停止仍保留 token。
- cargo fmt --check、cargo test：通过，10 项 Rust 测试及 main / doc tests 均通过。
- 页面回归：16 项通过，原有 14 项全部保留。初次新增用例的精确文本定位未包含单元格中的缓存明细，修正为模型行定位后全量通过，未改动产品逻辑或放宽等待时间。
- 真实 pnpm tauri dev：使用独立测试应用 / 数据目录 / 凭据命名空间和本地模拟模型，两轮成功生成后总 token 为 17 → 34，最终输入 20、输出 10、缓存读取 4、推理 6，参考费用未提供；会话切换不混入其他会话数据。
- 删除合成 Key 与自定义服务商后，仍能刷新历史用量；正常关闭重启后结果完全一致，已删除的模型目录项不影响历史账本展示。累计模型调用始终为 2 次，没有外部付费请求。
- 独立凭据命名空间剩余 0 项，测试桌面与本地模型已正常关闭；正式会话数据未触碰。git diff --check 通过。

建议提交名称：`feat(usage): 展示会话模型用量与参考费用`。本轮尚未提交或推送。
