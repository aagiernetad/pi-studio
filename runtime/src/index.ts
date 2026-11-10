
import { DurableHost } from "./durable/host.js";
import { registerDurableProbeHandlers } from "./durable/handlers.js";

import { RuntimeHandlerRegistry } from "./handlers/registry.js";
import { RuntimeRequestDispatcher } from "./handlers/dispatcher.js";
import { registerRuntimeHandlers } from "./handlers/runtime.js";

import { JsonlServer } from "./server/jsonl-server.js";

/**
 * Pi Studio Node.js Runtime 入口。
 *
 * 负责依赖初始化和生命周期，
 * 不直接实现 Agent 业务逻辑。
 */
async function main(): Promise<void> {
  const dataDir = process.env.PI_STUDIO_DATA_DIR;

  if (!dataDir) {
    throw new Error("PI_STUDIO_DATA_DIR is required");
  }

  const durableHost = await DurableHost.open(dataDir);

  process.stderr.write("[runtime] DurableHost ready\n");

  try {
    const registry = new RuntimeHandlerRegistry();

    registerRuntimeHandlers(registry);

    // 共享已初始化的 DurableHost
    registerDurableProbeHandlers(registry, durableHost);

    const dispatcher = new RuntimeRequestDispatcher(registry);

    const server = new JsonlServer(dispatcher, {
      maxConcurrentRequests: 8,
      requestTimeoutMs: 15_000,
      maxLineBytes: 64 * 1024,
      shutdownGraceMs: 3_000,
    });

    process.once("SIGINT", () => server.stop());
    process.once("SIGTERM", () => server.stop());

    await server.run();
  } finally {
    await durableHost.close();

    process.stderr.write("[runtime] DurableHost closed\n");
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[runtime] Fatal error: ${String(error)}\n`,
  );

  process.exitCode = 1;
});
