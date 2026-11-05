
# ADR-0001：Pi Studio 三项目融合架构

状态：Proposed
目标版本：V0.3.0
架构类型：Local-first Modular Monolith

## 1. 项目目标

Pi Studio 是基于 Tauri 2 的本地优先桌面 Agent 系统。

项目融合三个参考方向：

1. DeepSeek Super-agent：
   自主工作流、事件驱动、Router / Worker、
   Ticket / Assignment、持续运行和监督。

2. Pi Durable：
   Agent 执行、Conversation、Submission、
   Task、Checkpoint、持久化与恢复。

3. xiaotianna/pi-harness：
   本地 Daemon、Workspace、Provider、
   Tool / Skill / MCP、Policy、Sandbox、
   Memory、Task Board、Trace 和 Evals。

只吸收经过验证的架构思想和必要实现，
不复制整套互相冲突的 Runtime。

## 2. 总体技术架构

React + TypeScript
    ↓ Tauri Commands / Events
Rust Supervisor
    ↓ JSONL IPC V1
Node.js Runtime

Node.js Runtime：

- Application Composition Root
- Pi Durable Host
- Super-agent Domain Engine
- Provider Service
- Tool / Extension Integration
- Policy / Approval
- Workspace / Sandbox
- Memory / Retrieval
- Event Adapter / Observability

Persistence：

- Pi Durable Storage
- Application SQLite
- 独立 Credential Store
- Workspace File System

采用模块化单体，不拆微服务。

## 3. 三个参考项目的职责边界

### DeepSeek Super-agent

负责应用级业务工作流：

Source
Trigger
Thread
Eval
Decision
Policy
Mandate
Ticket
Assignment
Executor
Channel
Subscription

### Pi Durable

负责 Agent 执行与持久化：

Harness
Conversation
Entry
Submission
Task
Checkpoint
Extension
Registry
Task Graph
Recovery

### PI Harness

提供产品工程参考：

Workspace
Provider Management
Tool / Skill Discovery
MCP
Policy
Sandbox
Memory
Task Board
Trace
Usage
Evals

不直接复制其 AgentManager、RunCoordinator、
自定义 Session JSONL 和 Checkpoint 实现。

## 4. 核心领域映射

- Ticket 不等于 Durable Task。
- Assignment 不等于 Submission。
- Thread 不等于 Conversation。
- Task Board 是业务任务的读取投影。
- Worker 可以拥有独立 Durable Conversation。
- Worker 执行关系优先复用 Durable Task Graph。
- 一个 Ticket 可以经历多个 Assignment。
- 一个 Assignment 可以关联多个 Durable Tasks。

## 5. 运行时边界

- React 只负责展示和用户交互。
- Rust Supervisor 负责 Node.js 进程生命周期。
- Node.js Runtime 是 Durable Storage 的唯一所有者。
- Durable Harness 负责 Conversation 和 Task 的执行状态。
- Super-agent Engine 是 Ticket 等领域实体的唯一写入者。
- Pi 原始事件必须转换成 StudioEvent 后才能暴露给 UI。
- 不重复实现 Agent Loop、Task Scheduler 和 Checkpoint。
- 不让 UI 直接修改数据库或文件系统。

## 6. 工具和安全边界

Policy 决定操作能否执行。
Sandbox 决定操作最多能影响什么。

Policy 采用：

allow / ask / deny

所有副作用工具需要：

- 参数校验
- 权限检查
- 必要时人工审批
- 路径和资源边界检查
- 超时与 AbortSignal
- 幂等控制
- 审计事件

Skill 检索不代表工具授权。

MCP 工具按需发现和加载，不全量注入 Context。

## 7. Provider 与凭据

- 模型能力复用 pi-ai。
- 不重复实现模型协议客户端。
- 非敏感 Provider 配置由应用层管理。
- 凭据使用独立安全存储。
- 不将 API Key 写入 React、Transcript、日志和 Git。

## 8. 状态与存储

Pi Durable 拥有：

Conversation、Entries、Submissions、Tasks、
Checkpoints 和 Agent 执行记录。

Application Store 拥有：

Sources、Triggers、Threads、Decisions、
Tickets、Assignments、Policies、Workspaces、
Provider Settings、Approvals 和 Outbox。

Memory 是独立领域。

检索索引属于派生数据，必须可以重建。

Durable Storage 与 Application Store 的事务
边界需要通过原型实验确定。

## 9. 事件机制

Pi Durable Events
    ↓
Runtime Event Adapter
    ↓
StudioEvent
    ↓
Rust Supervisor
    ↓
React

持久化状态是事实来源。
实时事件用于增量通知。
前端重连后必须能够重新读取状态快照。

## 10. Agent 协作

Router 负责接收用户输入、协调工作和汇总结果。

Worker 负责具体执行，拥有独立执行身份、
工作范围和必要的独立 Conversation。

Worker 的创建、等待、消息、停止、
结果交付和恢复必须具备明确生命周期。

不允许无限制递归委派或无限并发。

## 11. 工程原则

- 如非必要勿增实体。
- 模块必须有明确职责和唯一所有者。
- 优先复用成熟框架能力。
- 不为抽象而抽象。
- 不为了功能展示牺牲安全边界。
- 先验证最小完整闭环，再扩展功能。
- 每个稳定里程碑必须测试并提交 GitHub。

## 12. 暂不纳入基础版本

- 云端多租户服务。
- 多机器分布式调度。
- 无授权的主动操作。
- 不受限制的 Shell 执行。
- Windows 尚未验证的 Computer Use。
- 自建重复的 Agent Loop 和 Durable Scheduler。

## 13. 官方参考项目

DeepSeek：
https://github.com/deepseek-ai/dsh-superagent-prototype

Pi Durable：
https://github.com/earendil-works/pi/tree/main/packages/durable

PI Harness：
https://github.com/xiaotianna/pi-harness
