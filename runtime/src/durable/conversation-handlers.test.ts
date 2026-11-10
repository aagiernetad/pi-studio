
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
import { createUserConversation } from "./conversations.js";
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
