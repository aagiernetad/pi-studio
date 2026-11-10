
import { isAbsolute, join } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  Harness,
  createRegistry,
  type Conversation,
  type ConversationId,
} from "@earendil-works/pi-durable";
import {
  openNodeSqliteStorage,
} from "@earendil-works/pi-durable/storage/sqlite/node";

/**
 * Pi Durable 应用级宿主。
 *
 * 负责 Harness 与 SQLite 生命周期，
 * 不负责业务会话分类、Agent Loop 和任务调度。
 */
export class DurableHost {
  private constructor(
     readonly harness: Harness,
  ) {}

  static async open(dataDir: string): Promise<DurableHost> {
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

    const harness = await Harness.open(
      storage,
      {
        models: createModels(),
        registry: createRegistry(),
      },
      BACKGROUND_CONTEXT,
    );

    // 当前没有自定义扩展。
    // 未来必须先注册持久化任务定义，再 resume。
    harness.resume();

    return new DurableHost(harness);
  }

  // 获取 Durable 内部 Root Conversation
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

  // 根据原生 ID 查询 Conversation
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
