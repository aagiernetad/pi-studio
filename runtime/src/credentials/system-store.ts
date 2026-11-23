import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { z } from "zod";

const CredentialSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("api_key"),
    key: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
  }).strict(),
  z.object({
    type: z.literal("oauth"),
    refresh: z.string(),
    access: z.string(),
    expires: z.number(),
  }).catchall(z.json()),
]);

/** 系统存储的窄边界；测试可注入独立后端，不接触用户凭据。 */
export interface SecretBackend {
  read(providerId: string): Promise<string | null>;
  write(providerId: string, value: string): Promise<void>;
  delete(providerId: string): Promise<void>;
  list(): Promise<readonly { account: string; password: string }[]>;
}

function decode(value: string): Credential {
  try {
    const parsed = CredentialSchema.safeParse(JSON.parse(value));
    if (parsed.success) return parsed.data;
  } catch {
    // 不将原始 JSON、校验细节或底层异常带入日志。
  }
  throw new Error("Stored credential is invalid");
}

/** 实现 pi-ai 原生协议；同一实例内的修改和删除按 Provider 串行。 */
export class SystemCredentialStore implements CredentialStore {
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly backend: SecretBackend) {}

  private async storage<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch {
      throw new Error("System credential store operation failed");
    }
  }

  private enqueue<T>(
    providerId: string,
    operation: () => Promise<T>,
    options?: AuthOperationOptions,
  ): Promise<T> {
    const previous = this.chains.get(providerId) ?? Promise.resolve();
    const queued = previous.then(async () => {
      options?.signal?.throwIfAborted();
      return operation();
    });
    const tail = queued.then(() => {}, () => {});
    this.chains.set(providerId, tail);
    void tail.then(() => {
      if (this.chains.get(providerId) === tail) this.chains.delete(providerId);
    });
    return queued;
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const value = await this.storage(() => this.backend.read(providerId));
    options?.signal?.throwIfAborted();
    return value === null ? undefined : decode(value);
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    const entries = await this.storage(() => this.backend.list());
    options?.signal?.throwIfAborted();
    return entries.map(({ account, password }) => ({
      providerId: account,
      type: decode(password).type,
    }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.enqueue(providerId, async () => {
      const current = await this.read(providerId, options);
      const next = await fn(current);
      options?.signal?.throwIfAborted();
      if (next === undefined) return current;

      // 校验后再序列化，错误消息不包含凭据；采用保守的 Windows 2560 字节上限。
      const parsed = CredentialSchema.safeParse(next);
      if (!parsed.success) throw new Error("Credential is invalid");
      const value = JSON.stringify(parsed.data);
      if (Math.max(Buffer.byteLength(value, "utf8"), Buffer.byteLength(value, "utf16le")) > 2560) {
        throw new Error("Credential exceeds system storage size limit");
      }

      // 原生写入开始后等待其完成，不因取消提前释放队列。
      await this.storage(() => this.backend.write(providerId, value));
      return parsed.data;
    }, options);
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.enqueue(providerId, () => this.storage(() => this.backend.delete(providerId)), options);
  }
}

export function createSystemCredentialStore(
  service = "com.pistudio.app.provider-credentials",
): SystemCredentialStore {
  async function native() {
    if (process.platform !== "win32") {
      throw new Error("System credential storage is not verified on this platform");
    }
    return import("@napi-rs/keyring");
  }

  return new SystemCredentialStore({
    async read(providerId) {
      const { AsyncEntry } = await native();
      return new AsyncEntry(service, providerId).getPassword();
    },
    async write(providerId, value) {
      const { AsyncEntry } = await native();
      await new AsyncEntry(service, providerId).setPassword(value);
    },
    async delete(providerId) {
      const { AsyncEntry } = await native();
      await new AsyncEntry(service, providerId).deleteCredential();
    },
    async list() {
      const { findCredentialsAsync } = await native();
      return findCredentialsAsync(service);
    },
  });
}
