import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\x00-\x1f\x7f]+$/);
export const CustomProviderId = z.string().regex(/^custom-[a-z0-9][a-z0-9-]{0,55}$/);
const endpoint = text(2048).refine((value) => {
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return (url.protocol === "https:" || (url.protocol === "http:" && local)) &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}, "Invalid endpoint").transform((value) => new URL(value).toString().replace(/\/+$/, ""));

/** 只允许非敏感配置；认证、额外 headers 与任意 SDK 配置均不在此契约中。 */
export const ProviderConfigSchema = z.object({
  id: CustomProviderId,
  name: text(80),
  baseUrl: endpoint,
  modelId: text(256),
  contextWindow: z.number().int().min(128).max(10_000_000),
  maxTokens: z.number().int().min(16).max(1_000_000),
}).strict().refine((value) => value.maxTokens <= value.contextWindow);
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
type ConfigDocument = { items: Record<string, ProviderConfig> };
const Configs = defineDoc<ConfigDocument>({
  kind: "studio.provider-settings", version: 1, scope: "session",
  initial: () => ({ items: {} }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 20,
});

export async function listProviderConfigs(harness: Harness): Promise<ProviderConfig[]> {
  const snapshot = await harness.snapshot(Configs, BACKGROUND_CONTEXT);
  const result = z.array(ProviderConfigSchema).max(32).safeParse(Object.values(snapshot?.items ?? {}));
  if (!result.success) throw new Error("Stored provider configuration is invalid");
  return result.data.sort((a, b) => a.id.localeCompare(b.id));
}

export async function writeProviderConfig(harness: Harness, config: ProviderConfig, signal: AbortSignal): Promise<void> {
  await harness.commit(async (tx) => {
    const document = await tx.doc(Configs);
    signal.throwIfAborted();
    if (!document.items[config.id] && Object.keys(document.items).length >= 32) {
      throw new Error("Provider configuration limit reached");
    }
    document.items[config.id] = config;
  }, BACKGROUND_CONTEXT);
}

export async function deleteProviderConfig(harness: Harness, id: string, signal: AbortSignal): Promise<void> {
  await harness.commit(async (tx) => {
    const document = await tx.doc(Configs);
    signal.throwIfAborted();
    delete document.items[id];
  }, BACKGROUND_CONTEXT);
}

/** 使用原生协议与认证实现；不创建第二套 Models 或客户端。 */
export function configuredProvider(config: ProviderConfig) {
  return createProvider({
    id: config.id, name: config.name, baseUrl: config.baseUrl,
    auth: { apiKey: envApiKeyAuth("API Key", []) },
    models: [{
      id: config.modelId, name: config.modelId, provider: config.id,
      api: "openai-completions", baseUrl: config.baseUrl,
      reasoning: false, input: ["text"],
      contextWindow: config.contextWindow, maxTokens: config.maxTokens,
      // 手动配置不声明上游价格；当前界面不展示价格 / 费用估算。
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" },
    }],
    api: openAICompletionsApi(),
  });
}
