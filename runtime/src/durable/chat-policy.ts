import type { AssistantMessage, Models, Usage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

export const CHAT_MAX_TOKENS = 2048;
export const CHAT_TIMEOUT_MS = 60_000;

const safeTokens = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const safeCost = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
function safeUsage(usage?: Usage): Usage {
  return {
    input: safeTokens(usage?.input), output: safeTokens(usage?.output),
    cacheRead: safeTokens(usage?.cacheRead), cacheWrite: safeTokens(usage?.cacheWrite), totalTokens: safeTokens(usage?.totalTokens),
    ...(usage?.reasoning !== undefined ? { reasoning: safeTokens(usage.reasoning) } : {}),
    ...(usage?.cacheWrite1h !== undefined ? { cacheWrite1h: safeTokens(usage.cacheWrite1h) } : {}),
    cost: {
      input: safeCost(usage?.cost?.input), output: safeCost(usage?.cost?.output),
      cacheRead: safeCost(usage?.cost?.cacheRead), cacheWrite: safeCost(usage?.cost?.cacheWrite), total: safeCost(usage?.cost?.total),
      ...(typeof usage?.cost?.totalFromProvider === "boolean" ? { totalFromProvider: usage.cost.totalFromProvider } : {}),
    },
  };
}

/** 在同一个 Models 的流入口应用请求边界；执行、重试和检查点仍归 Durable。 */
export function installChatPolicy(models: Models): void {
  const original = models.streamSimple.bind(models);
  models.streamSimple = (model, context, options = {}) => {
    const output = new AssistantMessageEventStream();
    const safeFailure = (aborted: boolean, usage?: Usage): AssistantMessage => ({
      role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: [], stopReason: aborted ? "aborted" : "error",
      errorMessage: aborted ? "请求已停止。" : "模型请求失败，请检查凭据、模型权限或网络。",
      timestamp: Date.now(),
      usage: safeUsage(usage),
    });
    const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(Math.min(options.timeoutMs ?? CHAT_TIMEOUT_MS, CHAT_TIMEOUT_MS))]);
    void (async () => {
      try {
        const events = original(model, context, {
          ...options, signal, maxRetries: 0, timeoutMs: Math.min(options.timeoutMs ?? CHAT_TIMEOUT_MS, CHAT_TIMEOUT_MS),
          maxTokens: Math.min(options.maxTokens ?? CHAT_MAX_TOKENS, model.maxTokens, CHAT_MAX_TOKENS),
          transport: "sse", cacheRetention: "none",
          fetch: (input, init) => fetch(input, { ...init, redirect: "error" }),
          onPayload: async (payload, requestedModel) => {
            const changed = await options.onPayload?.(payload, requestedModel);
            const final = changed ?? payload;
            if (!final || typeof final !== "object" || Array.isArray(final)) throw new Error("Unsupported request");
            const body = final as Record<string, unknown>;
            const limits = [body.max_tokens, body.max_completion_tokens, body.max_output_tokens].filter((value) => value !== undefined);
            if (!limits.length || limits.some((value) => typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > CHAT_MAX_TOKENS)) throw new Error("Unbounded request");
            return final;
          },
        });
        for await (const event of events) {
          if (event.type === "error") {
            const failure = safeFailure(event.reason === "aborted", event.error.usage);
            output.push({ type: "error", reason: failure.stopReason === "aborted" ? "aborted" : "error", error: failure });
          } else if (event.type === "done") {
            output.push(event);
          } else {
            output.push(event);
          }
        }
        const result = await events.result();
        output.end(result.stopReason === "error" || result.stopReason === "aborted" ? safeFailure(result.stopReason === "aborted", result.usage) : result);
      } catch {
        const failure = safeFailure(options.signal?.aborted ?? false);
        output.push({ type: "error", reason: failure.stopReason === "aborted" ? "aborted" : "error", error: failure });
        output.end(failure);
      }
    })();
    return output;
  };
}
