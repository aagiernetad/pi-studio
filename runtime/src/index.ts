
import { RuntimeHandlerRegistry } from "./handlers/registry.js";

import { RuntimeRequestDispatcher } from "./handlers/dispatcher.js";

import { registerRuntimeHandlers } from "./handlers/runtime.js";

import { JsonlServer } from "./server/jsonl-server.js";

/**
 * Pi Studio Agent Runtime 启动入口
 *
 * 只负责：
 * 1. 创建服务依赖
 * 2. 注册业务 Handler
 * 3. 初始化 JSONL Server
 * 4. 管理 Runtime 启动和关闭
 *
 * 不在入口中直接实现 Agent 业务逻辑。
 */
async function main(): Promise<void> {
  // 创建 Handler Registry
  const registry = new RuntimeHandlerRegistry();

  // 注册基础 Runtime Handler
  registerRuntimeHandlers(registry);

  // 创建请求分发器
  const dispatcher = new RuntimeRequestDispatcher(
    registry,
  );

  // 创建 JSONL Server
  const server = new JsonlServer(dispatcher, {
    maxConcurrentRequests: 8,
    requestTimeoutMs: 15_000,
    maxLineBytes: 64 * 1024,
    shutdownGraceMs: 3_000,
  });

  // 接收系统退出信号
  process.once("SIGINT", () => {
    server.stop();
  });

  process.once("SIGTERM", () => {
    server.stop();
  });

  // 启动 Runtime
  await server.run();
}

main().catch((error: unknown) => {
  // 不向 stdout 写日志
  process.stderr.write(
    `[runtime] Fatal error: ${String(error)}\n`,
  );

  process.exitCode = 1;
});
