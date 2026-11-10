
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { z } from "zod";

import { RuntimeApplicationError } from "../protocol/errors.js";
import { RuntimeHandlerRegistry } from "../handlers/registry.js";
import { DurableHost } from "./host.js";

const WriteParams = z.object({
  marker: z.string().min(1).max(128),
}).strict();

const ReadParams = z.object({}).strict();

/**
 * Durable 持久化诊断接口。
 *
 * 仅用于 V0.3 的跨进程验证。
 * 后续由正式的 Conversation IPC 替换。
 *
 * 不调用模型，不执行外部工具。
 */
export function registerDurableProbeHandlers(
  registry: RuntimeHandlerRegistry,
  host: DurableHost,
): void {
  registry.register("durable.probe.write", async (request) => {
    const parsed = WriteParams.safeParse(request.params);

    if (!parsed.success) {
      throw new RuntimeApplicationError(
        "INVALID_PARAMS",
        "Invalid durable.probe.write parameters.",
      );
    }

    const root = await host.root();

    await root.submit(
      {
        type: "write",
        entry: {
          kind: "app.persistence-probe",
          data: {
            marker: parsed.data.marker,
          },
        },
      },
      BACKGROUND_CONTEXT,
    );

    return {
      conversationId: root.id,
      marker: parsed.data.marker,
    };
  });

  registry.register("durable.probe.read", async (request) => {
    if (!ReadParams.safeParse(request.params).success) {
      throw new RuntimeApplicationError(
        "INVALID_PARAMS",
        "Invalid durable.probe.read parameters.",
      );
    }

    const root = await host.root();

    const page = await root.entries(
      {},
      100,
      undefined,
      BACKGROUND_CONTEXT,
    );

    const entry = [...page.items]
      .reverse()
      .find((item) => item.kind === "app.persistence-probe");

    return {
      conversationId: root.id,
      found: entry !== undefined,
      data: entry?.data ?? null,
    };
  });
}
