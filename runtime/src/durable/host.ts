
import { isAbsolute, join } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  Harness,
  createRegistry,
  type Conversation,
  type ConversationId,
} from "@earendil-works/pi-durable";
import {
  openNodeSqliteStorage,
} from "@earendil-works/pi-durable/storage/sqlite/node";
import { configuredProvider, listProviderConfigs } from "./provider-config.js";

/**
 * Pi Durable 应用级宿主。
 *
 * 管理 Harness、Models 和 SQLite 的生命周期。
 * 不负责 Agent Loop、业务任务或模型凭据存储。
 */
export class DurableHost {
  private constructor(
    readonly harness: Harness,
    readonly models: ReturnType<typeof builtinModels>,
  ) {}

  static async open(dataDir: string, credentials?: CredentialStore): Promise<DurableHost> {
    if (!isAbsolute(dataDir)) {
      throw new Error(
        "Durable data directory must be absolute",
      );
    }

    const databasePath = join(
      dataDir,
      "pi-studio.sqlite",
    );

    const storage = await openNodeSqliteStorage(
      databasePath,
    );

    // 整个 Runtime 生命周期只创建一次 Models。
    // Provider 管理和 Harness 共享同一个实例。
    const models = builtinModels({ credentials });

    const harness = await Harness.open(
      storage,
      {
        models,
        registry: createRegistry(),
      },
      BACKGROUND_CONTEXT,
    );

    // 恢复应用配置后再恢复任务；仍使用同一个 Models。
    try {
      for (const config of await listProviderConfigs(harness)) {
        models.setProvider(configuredProvider(config));
      }
    } catch {
      await harness.close(BACKGROUND_CONTEXT);
      throw new Error("Provider configuration could not be restored");
    }

    // 恢复持久化任务
    harness.resume();

    return new DurableHost(harness, models);
  }

  // 获取内部 Root Conversation
  async root(): Promise<Conversation> {
    return this.harness.root(BACKGROUND_CONTEXT);
  }

  // 创建独立 Conversation
  async createConversation(): Promise<Conversation> {
    return this.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
      },
      BACKGROUND_CONTEXT,
    );
  }

  // 根据 ID 查找 Conversation
  async conversation(
    id: ConversationId,
  ): Promise<Conversation | undefined> {
    return this.harness.conversation(
      id,
      BACKGROUND_CONTEXT,
    );
  }

  async close(): Promise<void> {
    await this.harness.close(BACKGROUND_CONTEXT);
  }
}
