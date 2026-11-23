import { z } from "zod";
import type { DurableHost } from "../durable/host.js";
import { configuredProvider, CustomProviderId, deleteProviderConfig, listProviderConfigs, ProviderConfigSchema, writeProviderConfig } from "../durable/provider-config.js";
import { RuntimeApplicationError } from "../protocol/errors.js";
import { RuntimeHandlerRegistry } from "./registry.js";

export function registerProviderConfigHandlers(registry: RuntimeHandlerRegistry, host: DurableHost): void {
  // 配置提交与 Models 发布作为一个串行步骤；失败不改变运行目录。
  let pending = Promise.resolve();
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation);
    pending = result.then(() => {}, () => {});
    return result;
  }
  registry.register("provider.config.list", async (request) => {
    if (!z.object({}).strict().safeParse(request.params).success) {
      throw new RuntimeApplicationError("INVALID_PARAMS", "Invalid configuration parameters.");
    }
    await pending;
    return { items: await listProviderConfigs(host.harness) };
  });
  registry.register("provider.config.set", async (request, context) => {
    const parsed = ProviderConfigSchema.safeParse(request.params);
    if (!parsed.success) throw new RuntimeApplicationError("INVALID_PARAMS", "Invalid provider configuration.");
    return serial(async () => {
      context.signal.throwIfAborted();
      const config = parsed.data;
      const provider = configuredProvider(config);
      try {
        await writeProviderConfig(host.harness, config, context.signal);
      } catch {
        throw new RuntimeApplicationError("PROVIDER_CONFIG_FAILED", "Provider configuration could not be saved.");
      }
      host.models.setProvider(provider);
      context.emit("provider.config.changed", { providerId: config.id });
      return config;
    });
  });
  registry.register("provider.config.delete", async (request, context) => {
    const parsed = z.object({ providerId: CustomProviderId }).strict().safeParse(request.params);
    if (!parsed.success) throw new RuntimeApplicationError("INVALID_PARAMS", "Invalid custom provider id.");
    return serial(async () => {
      context.signal.throwIfAborted();
      try {
        await deleteProviderConfig(host.harness, parsed.data.providerId, context.signal);
      } catch {
        throw new RuntimeApplicationError("PROVIDER_CONFIG_FAILED", "Provider configuration could not be deleted.");
      }
      // 这里只删除非敏感配置；凭据继续由独立 credential 接口管理。
      host.models.deleteProvider(parsed.data.providerId);
      context.emit("provider.config.changed", { providerId: parsed.data.providerId });
      return { providerId: parsed.data.providerId, deleted: true };
    });
  });
}
