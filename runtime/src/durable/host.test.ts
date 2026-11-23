
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness } from "@earendil-works/pi-durable";

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


test(
  "DurableHost persists independent conversations",
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "pi-studio-conversations-"),
    );

    const markerA = randomUUID();
    const markerB = randomUUID();

    let host: DurableHost | undefined;

    try {
      // 1. 创建两个独立 Conversation
      host = await DurableHost.open(directory);

      const first = await host.createConversation();
      const second = await host.createConversation();

      assert.notEqual(first.id, second.id);

      const firstId = first.id;
      const secondId = second.id;

      // 2. 分别写入不同内容
      await first.submit(
        {
          type: "write",
          entry: {
            kind: "app.persistence-probe",
            data: { marker: markerA },
          },
        },
        BACKGROUND_CONTEXT,
      );

      await second.submit(
        {
          type: "write",
          entry: {
            kind: "app.persistence-probe",
            data: { marker: markerB },
          },
        },
        BACKGROUND_CONTEXT,
      );

      // 3. 关闭并重新打开 SQLite
      await host.close();
      host = undefined;

      host = await DurableHost.open(directory);

      const restoredA = await host.conversation(firstId);
      const restoredB = await host.conversation(secondId);

      assert.ok(restoredA, "Conversation A not found");
      assert.ok(restoredB, "Conversation B not found");

      // 4. 重新读取各自的 Transcript
      const entriesA = await restoredA.entries(
        {},
        100,
        undefined,
        BACKGROUND_CONTEXT,
      );

      const entriesB = await restoredB.entries(
        {},
        100,
        undefined,
        BACKGROUND_CONTEXT,
      );

      const markersA = entriesA.items
        .filter((entry) =>
          entry.kind === "app.persistence-probe"
        )
        .map((entry) => entry.data);

      const markersB = entriesB.items
        .filter((entry) =>
          entry.kind === "app.persistence-probe"
        )
        .map((entry) => entry.data);

      // 5. 验证内容独立且没有混淆
      assert.deepEqual(markersA, [
        { marker: markerA },
      ]);

      assert.deepEqual(markersB, [
        { marker: markerB },
      ]);
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


test("DurableHost shares built-in models with its Harness", async (context) => {
  // 记录真实调用，仍打开真实 Harness / SQLite，不调用模型 API。
  const open = context.mock.method(Harness, "open");
  const directory = await mkdtemp(
    join(tmpdir(), "pi-studio-models-"),
  );

  let host: DurableHost | undefined;

  try {
    host = await DurableHost.open(directory);

    assert.equal(open.mock.callCount(), 1);
    assert.strictEqual(
      open.mock.calls[0]?.arguments[1].models,
      host.models,
      "Harness must receive the Models collection exposed by the host",
    );

    const providerIds = host.models
      .getProviders()
      .map((provider) => provider.id);

    // 目录读取不需要凭据；目录存在不代表认证或推理可用。
    for (const providerId of ["deepseek", "openai", "anthropic"]) {
      assert.ok(providerIds.includes(providerId));

      const models = host.models.getModels(providerId);
      assert.ok(models.length > 0, `${providerId} catalog is empty`);
      assert.ok(models.every((model) => model.provider === providerId));

      for (const model of models) {
        assert.deepEqual(
          host.models.getModel(providerId, model.id),
          model,
        );
      }
    }

    // 确认原有 Durable Harness 仍可正常使用
    const root = await host.root();

    assert.ok(root.id);
  } finally {
    if (host) {
      await host.close();
    }

    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
});
