import type { Models } from "@earendil-works/pi-ai/models";
import { z } from "zod";

import { RuntimeApplicationError } from "../protocol/errors.js";
import { RuntimeHandlerRegistry } from "./registry.js";
import { supportsConnectionTest } from "./provider-test.js";

const ProviderListParams = z.object({}).strict();
const ModelListParams = z.object({
  providerId: z.string().trim().min(1).max(128),
}).strict();

function catalogResult<T>(items: T[]): { items: T[] } {
  const result = { items };

  // 与 Conversation IPC 保持相同响应预算，低于 Rust 单行上限。
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 512 * 1024) {
    throw new RuntimeApplicationError(
      "RESPONSE_TOO_LARGE",
      "Catalog response is too large.",
    );
  }

  return result;
}

/** 只读目录：直接使用 Host 的 Models，不解析凭据或刷新远程目录。 */
export function registerProviderHandlers(
  registry: RuntimeHandlerRegistry,
  models: Models,
): void {
  registry.register("provider.list", (request) => {
    if (!ProviderListParams.safeParse(request.params).success) {
      throw new RuntimeApplicationError(
        "INVALID_PARAMS",
        "Invalid provider.list parameters.",
      );
    }

    return catalogResult(models.getProviders()
      .map((provider) => ({
        id: provider.id,
        name: provider.name,
        supportsApiKey: Boolean(provider.auth.apiKey?.login),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)));
  });

  registry.register("model.list", (request) => {
    const parsed = ModelListParams.safeParse(request.params);

    if (!parsed.success) {
      throw new RuntimeApplicationError(
        "INVALID_PARAMS",
        "Invalid model.list parameters.",
      );
    }

    const { providerId } = parsed.data;

    if (!models.getProvider(providerId)) {
      throw new RuntimeApplicationError(
        "PROVIDER_NOT_FOUND",
        "Provider does not exist.",
      );
    }

    // 显式选择字段，防止 headers、endpoint 或认证实现进入 IPC。
    return catalogResult(models.getModels(providerId)
      .map((model) => ({
        id: model.id,
        name: model.name,
        provider: model.provider,
        api: model.api,
        reasoning: model.reasoning,
        input: [...model.input],
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        supportsConnectionTest: supportsConnectionTest(model.api),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)));
  });
}
