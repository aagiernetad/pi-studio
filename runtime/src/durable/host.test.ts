
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

import { DurableHost } from "./host.js";

test(
  "DurableHost persists conversation entries across reopen",
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "pi-studio-durable-"),
    );

    const marker = randomUUID();
    let host: DurableHost | undefined;

    try {
      // 1. 首次打开数据库
      host = await DurableHost.open(directory);

      const root = await host.root();
      const firstId = root.id;

      // 2. 写入一条真正的 Durable Entry
      // write 不调用大模型
      await root.submit(
        {
          type: "write",
          entry: {
            kind: "app.persistence-probe",
            data: { marker },
          },
        },
        BACKGROUND_CONTEXT,
      );

      // 3. 正常关闭数据库
      await host.close();
      host = undefined;

      // 4. 确认 SQLite 文件确实存在
      await stat(join(directory, "pi-studio.sqlite"));

      // 5. 重新打开同一个数据库
      host = await DurableHost.open(directory);

      const restoredRoot = await host.root();

      assert.equal(restoredRoot.id, firstId);

      // 6. 从持久化 Transcript 中读取数据
      const page = await restoredRoot.entries(
        {},
        100,
        undefined,
        BACKGROUND_CONTEXT,
      );

      const savedEntry = page.items.find(
        (entry) =>
          entry.kind === "app.persistence-probe",
      );

      // 7. 断言内容与重启之前完全一致
      assert.ok(savedEntry, "Persisted entry not found");

      assert.deepEqual(
        savedEntry.data,
        { marker },
      );
    } finally {
      if (host) {
        await host.close();
      }

      await rm(directory, {
        recursive: true,
        force: true,
      });
    }
  },
);
