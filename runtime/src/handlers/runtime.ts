
import { z } from "zod";

import {
  RuntimeApplicationError,
} from "../protocol/errors.js";

import { RuntimeHandlerRegistry } from "./registry.js";

/**
 * Ping 参数校验。
 */
const PingParamsSchema = z.object({
  message: z.string().max(4096).optional(),
}).strict();

/**
 * 注册 Runtime 相关 Handler。
 */
export function registerRuntimeHandlers(
  registry: RuntimeHandlerRegistry,
): void {
  // runtime.ping
  registry.register("runtime.ping", (request) => {
    const parsed = PingParamsSchema.safeParse(request.params);

    if (!parsed.success) {
      throw new RuntimeApplicationError(
        "INVALID_PARAMS",
        "Invalid runtime.ping parameters.",
        {
          details: {
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.map(String).join("."),
              message: issue.message,
            })),
          },
        },
      );
    }

    return {
      message:
        parsed.data.message ?? "Hello from Pi Studio Runtime",
      runtime: "node",
      pid: process.pid,
    };
  });

  // runtime.info
  registry.register("runtime.info", () => {
    return {
      name: "Pi Studio Runtime",
      platform: process.platform,
      nodeVersion: process.version,
      pid: process.pid,
      uptime: process.uptime(),
    };
  });
}
