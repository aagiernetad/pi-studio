import type { CredentialStore } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { z } from "zod";

import { RuntimeApplicationError } from "../protocol/errors.js";
import { RuntimeHandlerRegistry } from "./registry.js";

const ProviderParams = z.object({
  providerId: z.string().trim().min(1).max(128),
}).strict();
const SetParams = ProviderParams.extend({
  apiKey: z.string().trim().min(1).max(1024).regex(/^[^\s\x00-\x1f\x7f]+$/),
});

async function credentialOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    // 系统错误、解析异常可能携带密钥，不能传递 cause 或原始消息。
    throw new RuntimeApplicationError(
      "CREDENTIAL_STORE_UNAVAILABLE",
      "System credential store is unavailable.",
    );
  }
}

export function registerProviderCredentialHandlers(
  registry: RuntimeHandlerRegistry,
  models: Models,
  credentials: CredentialStore,
): void {
  function validate<T>(schema: z.ZodType<T>, params: unknown): T {
    const parsed = schema.safeParse(params);
    if (!parsed.success) {
      throw new RuntimeApplicationError("INVALID_PARAMS", "Invalid credential parameters.");
    }
    return parsed.data;
  }

  function provider(providerId: string) {
    const found = models.getProvider(providerId);
    if (!found) {
      throw new RuntimeApplicationError("PROVIDER_NOT_FOUND", "Provider does not exist.");
    }
    return found;
  }

  registry.register("provider.credential.status", async (request, context) => {
    const { providerId } = validate(ProviderParams, request.params);
    provider(providerId);
    const credential = await credentialOperation(() => credentials.read(providerId, { signal: context.signal }));
    return { providerId, stored: credential !== undefined, type: credential?.type ?? null };
  });

  registry.register("provider.credential.set", async (request, context) => {
    const { providerId, apiKey } = validate(SetParams, request.params);
    if (!provider(providerId).auth.apiKey?.login) {
      throw new RuntimeApplicationError("PROVIDER_API_KEY_UNSUPPORTED", "Provider does not support API key setup.");
    }
    await credentialOperation(() => credentials.modify(providerId, async (current) => ({
      ...(current?.type === "api_key" ? current : {}),
      type: "api_key",
      key: apiKey,
    }), { signal: context.signal }));
    context.emit("provider.credential.changed", { providerId, stored: true });
    return { providerId, stored: true, type: "api_key" };
  });

  registry.register("provider.credential.delete", async (request, context) => {
    const { providerId } = validate(ProviderParams, request.params);
    provider(providerId);
    await credentialOperation(() => credentials.delete(providerId, { signal: context.signal }));
    context.emit("provider.credential.changed", { providerId, stored: false });
    return { providerId, stored: false, type: null };
  });
}
