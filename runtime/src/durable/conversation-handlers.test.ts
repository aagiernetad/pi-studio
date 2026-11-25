
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";

import { RuntimeRequestSchema } from "../protocol/messages.js";
import { RuntimeHandlerRegistry } from "../handlers/registry.js";
import { RuntimeRequestDispatcher } from "../handlers/dispatcher.js";

import { DurableHost } from "./host.js";
import { createUserConversation, getUserConversation, renameUserConversation } from "./conversations.js";
import { registerConversationHandlers } from "./conversation-handlers.js";

test("conversation.entries supports pagination and visibility", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "pi-studio-entries-"),
  );

  let host: DurableHost | undefined;

  try {
    host = await DurableHost.open(directory);

    const user = await createUserConversation(
      host.harness,
      randomUUID(),
      "分页测试",
    );

    const conversation = await host.conversation(
      user.id as ConversationId,
    );

    assert.ok(conversation);

    // 写入三个测试 Entry，不调用模型
    for (const step of [1, 2, 3]) {
      await conversation.submit(
        {
          type: "write",
          entry: {
            kind: "app.test-note",
            data: { step },
          },
        },
        BACKGROUND_CONTEXT,
      );
    }

    const registry = new RuntimeHandlerRegistry();
    registerConversationHandlers(registry, host);

    const dispatcher = new RuntimeRequestDispatcher(registry);

    async function requestEntries(params: Record<string, unknown>) {
      return dispatcher.dispatch(
        RuntimeRequestSchema.parse({
          version: 1,
          kind: "request",
          id: randomUUID(),
          method: "conversation.entries",
          params,
        }),
        {
          requestId: randomUUID(),
          receivedAt: Date.now(),
          signal: new AbortController().signal,
          emit: () => {},
        },
      );
    }

    // 第一页：最新两条
    const first = await requestEntries({
      conversationId: user.id,
      limit: 2,
    });

    assert.equal(first.success, true);

    const firstItems = first.result?.items;
    assert.ok(Array.isArray(firstItems));
    assert.deepEqual(
      firstItems.map((entry) => entry.data),
      [{ step: 3 }, { step: 2 }],
    );

    const cursor = first.result?.nextCursor;
    assert.ok(cursor && typeof cursor === "object");

    // 第二页：更早的一条
    const second = await requestEntries({
      conversationId: user.id,
      limit: 2,
      cursor,
    });

    assert.equal(second.success, true);

    const secondItems = second.result?.items;
    assert.ok(Array.isArray(secondItems));
    assert.deepEqual(
      secondItems.map((entry) => entry.data),
      [{ step: 1 }],
    );

    assert.equal(second.result?.nextCursor, null);

    // 内部 Root Conversation 不能被公开读取
    const root = await host.root();

    const forbidden = await requestEntries({
      conversationId: root.id,
      limit: 10,
    });

    assert.equal(forbidden.success, false);
    assert.equal(
      forbidden.error?.code,
      "CONVERSATION_NOT_FOUND",
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
});

function conversationRequester(host: DurableHost) {
  const registry = new RuntimeHandlerRegistry();
  registerConversationHandlers(registry, host);
  const dispatcher = new RuntimeRequestDispatcher(registry);
  return (method: string, params: Record<string, unknown>) => {
    const id = randomUUID();
    return dispatcher.dispatch({ version: 1, kind: "request", id, method, params }, {
      requestId: id, receivedAt: Date.now(), signal: new AbortController().signal, emit: () => {},
    });
  };
}

test("rename persists metadata without changing transcript or create idempotence, and rejects hidden or invalid targets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-studio-rename-"));
  let host: DurableHost | undefined;
  try {
    host = await DurableHost.open(directory);
    const creationId = randomUUID();
    const user = await createUserConversation(host.harness, creationId, "旧标题");
    const other = await createUserConversation(host.harness, randomUUID(), "另一个会话");
    const native = await host.conversation(user.id as ConversationId);
    assert.ok(native);
    await native.submit({ type: "write", entry: { kind: "app.test-note", data: { text: "原历史" } } }, BACKGROUND_CONTEXT);
    let request = conversationRequester(host);
    const before = await request("conversation.entries", { conversationId: user.id });
    assert.ok(before.success);
    const [first, retry] = await Promise.all([1, 2].map(() => request("conversation.rename", { conversationId: user.id, title: "  项目计划  " })));
    assert.ok(first.success && retry.success);
    assert.deepEqual(first.result, retry.result);
    assert.deepEqual(first.result.conversation, { ...user, title: "项目计划" });
    const afterRename = await request("conversation.entries", { conversationId: user.id });
    assert.ok(afterRename.success);
    assert.deepEqual(afterRename.result, before.result);
    assert.equal((await getUserConversation(host.harness, other.id))?.title, "另一个会话");
    const root = await host.root();
    for (const conversationId of [root.id, 999999]) {
      const result = await request("conversation.rename", { conversationId, title: "不能修改" });
      assert.ok(!result.success);
      assert.equal(result.error.code, "CONVERSATION_NOT_FOUND");
    }
    for (const params of [
      {}, { conversationId: user.id, title: " " }, { conversationId: user.id, title: "x".repeat(121) },
      { conversationId: -1, title: "标题" }, { conversationId: user.id, title: 42 },
      { conversationId: user.id, title: "标题", extra: true },
    ]) {
      const result = await request("conversation.rename", params);
      assert.ok(!result.success);
      assert.equal(result.error.code, "INVALID_PARAMS");
    }
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(renameUserConversation(host.harness, user.id, "不应保存", abort.signal));
    await host.close();
    host = await DurableHost.open(directory);
    request = conversationRequester(host);
    const restored = await request("conversation.get", { conversationId: user.id });
    assert.ok(restored.success);
    assert.deepEqual(restored.result.conversation, { ...user, title: "项目计划" });
    assert.deepEqual(await createUserConversation(host.harness, creationId, "旧标题"), { ...user, title: "项目计划" });
    const afterRestart = await request("conversation.entries", { conversationId: user.id });
    assert.ok(afterRestart.success);
    assert.deepEqual(afterRestart.result, before.result);
  } finally {
    await host?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("title search covers the complete user index before pagination and reflects renames", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-studio-search-"));
  let host: DurableHost | undefined;
  try {
    host = await DurableHost.open(directory);
    const matches = [];
    for (let index = 0; index < 26; index++) {
      const item = await createUserConversation(host.harness, randomUUID(), index < 3 ? `项目 Plan ${index}` : `普通会话 ${index}`);
      if (index < 3) matches.unshift(item);
    }
    const request = conversationRequester(host);
    const page = await request("conversation.list", { query: "  pLaN  ", limit: 2 });
    assert.ok(page.success);
    assert.deepEqual(page.result.items, matches.slice(0, 2));
    assert.equal(page.result.nextBeforeId, matches[1]!.id);
    const next = await request("conversation.list", { query: "plan", limit: 2, beforeId: matches[1]!.id });
    assert.ok(next.success);
    assert.deepEqual(next.result.items, matches.slice(2));
    assert.equal(next.result.nextBeforeId, null);
    const renamed = await request("conversation.rename", { conversationId: matches[0]!.id, title: "已整理" });
    assert.ok(renamed.success);
    const chinese = await request("conversation.list", { query: "项目" });
    assert.ok(chinese.success);
    assert.deepEqual(chinese.result.items, matches.slice(1));
    const empty = await request("conversation.list", { query: "不存在" });
    assert.ok(empty.success);
    assert.deepEqual(empty.result, { items: [], nextBeforeId: null });
    const unfiltered = await request("conversation.list", {});
    assert.ok(unfiltered.success);
    assert.ok(Array.isArray(unfiltered.result.items));
    assert.equal(unfiltered.result.items.length, 20);
    for (const query of [42, null, "x".repeat(121)]) {
      const result = await request("conversation.list", { query });
      assert.ok(!result.success);
      assert.equal(result.error.code, "INVALID_PARAMS");
    }
  } finally {
    await host?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
