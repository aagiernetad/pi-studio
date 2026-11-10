
import { isAbsolute, join } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  Harness,
  createRegistry,
} from "@earendil-works/pi-durable";
import {
  openNodeSqliteStorage,
} from "@earendil-works/pi-durable/storage/sqlite/node";

/**
 * Pi Durable 的应用级宿主。
 *
 * 只负责 Harness 与 SQLite 生命周期，
 * 不实现 Agent Loop、Scheduler 或 Checkpoint。
 */
export class DurableHost {
  private constructor(
    private readonly harness: Harness,
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

    // 当前没有自定义任务或扩展。
    // 将来必须先完成扩展注册，再恢复任务。
    harness.resume();

    return new DurableHost(harness);
  }

  /**
   * 获取 Durable 原生 Root Conversation。
   * 不创建第二套 Conversation Manager。
   */
  async root() {
    return this.harness.root(BACKGROUND_CONTEXT);
  }

  async close(): Promise<void> {
    await this.harness.close(BACKGROUND_CONTEXT);
  }
}
