
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DurableHost } from "./host.js";
import {
  createUserConversation,
  listUserConversations,
} from "./conversations.js";

test("user conversations are isolated and idempotent", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "pi-studio-user-conv-"),
  );

  let host: DurableHost | undefined;

  const requestA = randomUUID();
  const requestB = randomUUID();

  try {
    host = await DurableHost.open(directory);

    // 内部 Root 不应该自动出现在用户会话列表
    await host.root();

    const first = await createUserConversation(
      host.harness,
      requestA,
      "研究项目",
    );

    const second = await createUserConversation(
      host.harness,
      requestB,
      "代码开发",
    );

    assert.notEqual(first.id, second.id);

    // 模拟 IPC 重试
    const duplicate = await createUserConversation(
      host.harness,
      requestA,
      "研究项目",
    );

    assert.equal(duplicate.id, first.id);

    const beforeRestart = await listUserConversations(
      host.harness,
    );

    assert.equal(beforeRestart.items.length, 2);
    assert.deepEqual(
      beforeRestart.items.map((item) => item.id),
      [second.id, first.id],
    );

    await host.close();
    host = undefined;

    // 重新打开同一个数据库
    host = await DurableHost.open(directory);

    const afterRestart = await listUserConversations(
      host.harness,
    );

    assert.deepEqual(
      afterRestart,
      beforeRestart,
    );

    // 跨重启再次提交相同 requestId
    const retried = await createUserConversation(
      host.harness,
      requestA,
      "研究项目",
    );

    assert.equal(retried.id, first.id);

    const finalList = await listUserConversations(
      host.harness,
    );

    assert.equal(finalList.items.length, 2);
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
