import type { Models } from "@earendil-works/pi-ai/models";
import { z } from "zod";

import { RuntimeApplicationError } from "../protocol/errors.js";
import { RuntimeHandlerRegistry } from "./registry.js";

const Params = z.object({
  providerId: z.string().trim().min(1).max(128),
  modelId: z.string().trim().min(1).max(256),
}).strict();

export function supportsConnectionTest(api: string): boolean {
  return ["openai-completions", "openai-responses", "anthropic-messages"].includes(api);
}

/** 显式连接检查，可能产生少量模型费用；不读取或创建 Conversation。 */
export function registerProviderTestHandlers(
  registry: RuntimeHandlerRegistry,
  models: Models,
  timeoutMs = 8_000,
): void {
  registry.register("provider.test", async (request, context) => {
    const parsed = Params.safeParse(request.params);
    if (!parsed.success) {
      throw new RuntimeApplicationError("INVALID_PARAMS", "Invalid provider.test parameters.");
    }
    const { providerId, modelId } = parsed.data;
    if (!models.getProvider(providerId)) {
      throw new RuntimeApplicationError("PROVIDER_NOT_FOUND", "Provider does not exist.");
    }
    const model = models.getModel(providerId, modelId);
    if (!model) {
      throw new RuntimeApplicationError("MODEL_NOT_FOUND", "Model does not exist in this provider catalog.");
    }
    if (!supportsConnectionTest(model.api)) {
      throw new RuntimeApplicationError("PROVIDER_TEST_UNSUPPORTED", "Connection test is not supported for this model API.");
    }

    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)]);
    const started = performance.now();
    try {
      const auth = await models.checkAuth(providerId, { signal });
      if (!auth) {
        throw new RuntimeApplicationError("PROVIDER_NOT_CONFIGURED", "Provider authentication is not configured.");
      }
      if (auth.type !== "api_key") {
        throw new RuntimeApplicationError("PROVIDER_TEST_UNSUPPORTED", "Connection test currently requires API key authentication.");
      }
      signal.throwIfAborted();

      const result = await models.completeSimple(model, {
        messages: [{ role: "user", content: "Reply with OK.", timestamp: Date.now() }],
      }, {
        signal,
        timeoutMs,
        maxRetries: 0,
        maxTokens: 16,
        transport: "sse",
        cacheRetention: "none",
        // 某些模型兼容配置会省略或覆盖输出上限；此时不发送测试请求。
        onPayload: (payload) => {
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            throw new Error("Connection test payload is unsupported");
          }
          const body = payload as Record<string, unknown>;
          const limits = [body.max_tokens, body.max_completion_tokens, body.max_output_tokens]
            .filter((value) => value !== undefined);
          if (limits.length === 0 || limits.some((value) => typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 16)) {
            throw new Error("Connection test requires a bounded output limit");
          }
        },
        // 复用 pi-ai 的请求协议；不跟随 HTTP 重定向转发凭据。
        fetch: (input, init) => fetch(input, { ...init, redirect: "error" }),
      });
      signal.throwIfAborted();
      if (result.stopReason !== "stop" && result.stopReason !== "length") {
        throw new RuntimeApplicationError("PROVIDER_TEST_FAILED", "Provider connection test failed.");
      }

      context.emit("provider.tested", { providerId, modelId, connected: true });
      return { providerId, modelId, connected: true, durationMs: Math.ceil(performance.now() - started) };
    } catch (error) {
      // 错误对象与模型输出都可能包含密钥或上游响应，禁止向 IPC / 日志转发。
      context.emit("provider.tested", { providerId, modelId, connected: false });
      if (signal.aborted) {
        throw new RuntimeApplicationError(
          context.signal.aborted ? "REQUEST_CANCELLED" : "PROVIDER_TEST_TIMEOUT",
          context.signal.aborted ? "Connection test was cancelled." : "Provider connection test timed out.",
        );
      }
      if (error instanceof RuntimeApplicationError && error.code === "PROVIDER_NOT_CONFIGURED") {
        throw new RuntimeApplicationError("PROVIDER_NOT_CONFIGURED", "Provider authentication is not configured.");
      }
      if (error instanceof RuntimeApplicationError && error.code === "PROVIDER_TEST_UNSUPPORTED") {
        throw new RuntimeApplicationError("PROVIDER_TEST_UNSUPPORTED", "Connection test currently requires API key authentication.");
      }
      throw new RuntimeApplicationError("PROVIDER_TEST_FAILED", "Provider connection test failed.");
    }
  });
}
