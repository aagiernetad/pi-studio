
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  defineDoc,
  type Harness,
  type ConversationId,
  type EntryId,
} from "@earendil-works/pi-durable";
import { RuntimeApplicationError } from "../protocol/errors.js";

export type UserConversation  = {
  id: number;
  title: string;
  createdAt: number;
  forkedFrom?: { conversationId: number; entryId: number };
};

type UserConversationIndex =  {
  items: Record<string, UserConversation>;
  requests: Record<string, number>;
};

/**
 * 用户可见会话索引。
 *
 * 使用 Durable 原生 Session Document。
 * 它只记录应用层的会话用途及基础信息；
 * Conversation 和 Transcript 仍由 Durable 管理。
 */
const UserConversations = defineDoc<UserConversationIndex>({
  kind: "studio.user-conversations",
  version: 1,
  scope: "session",

  initial: () => ({
    items: {},
    requests: {},
  }),

  checkpointWhen: (_value, _ops, info) =>
    info.deltasSinceBase >= 50,
});

/**
 * 创建用户会话。
 *
 * 会话创建与索引登记在同一个 Durable Commit 中。
 * 同一个 requestId 返回原来的 Conversation。
 */
export async function createUserConversation(
  harness: Harness,
  requestId: string,
  title = "新建会话",
): Promise<UserConversation> {
  return harness.commit(async (tx) => {
    const index = await tx.doc(UserConversations);

    const existingId = index.requests[requestId];

    if (existingId !== undefined) {
      const existing = index.items[String(existingId)];

      if (!existing) {
        throw new Error("Conversation index is inconsistent");
      }

      if (existing.forkedFrom) {
        throw new RuntimeApplicationError("REQUEST_ID_CONFLICT", "Request ID belongs to another operation.");
      }

      return {
        id: existing.id,
        title: existing.title,
        createdAt: existing.createdAt,
      };
    }

    // 创建真正的 Pi Durable Conversation
    const created = await tx.createConversation({
      ownership: { kind: "ownerless" },
    });

    const conversation: UserConversation = {
      id: created.id,
      title,
      createdAt: Date.now(),
    };

    index.items[String(created.id)] = conversation;
    index.requests[requestId] = created.id;

    return conversation;
  }, BACKGROUND_CONTEXT);
}

/**
 * 读取用户可见会话列表。
 *
 * 仅从 Studio 索引读取，不将 Root / Worker
 * 等内部 Conversation 自动暴露给用户。
 */
export async function listUserConversations(
  harness: Harness,
  limit = 20,
  beforeId?: number,
  query = "",
): Promise<{
  items: UserConversation[];
  nextBeforeId: number | null;
}> {
  const index = await harness.snapshot(
    UserConversations,
    BACKGROUND_CONTEXT,
  );

  const sorted = Object.values(index?.items ?? {})
    .filter((item) => item.title.toLowerCase().includes(query.toLowerCase()))
    .filter((item) =>
      beforeId === undefined || item.id < beforeId
    )
    .sort((a, b) => b.id - a.id);

  const page = sorted.slice(0, limit);
  const hasMore = sorted.length > limit;

  return {
    items: page,
    nextBeforeId:
      hasMore && page.length > 0
        ? page[page.length - 1]!.id
        : null,
  };
}

/**
 * 查询一个用户可见的 Conversation。
 *
 * 只查询 Studio 会话索引，避免将 Root、
 * Router、Worker 等内部 Conversation 暴露给 UI。
 */
export async function getUserConversation(
  harness: Harness,
  id: number,
): Promise<UserConversation | null> {
  const index = await harness.snapshot(
    UserConversations,
    BACKGROUND_CONTEXT,
  );

  return index?.items[String(id)] ?? null;
}

/** 仅修改 Studio 标题；不改变 Durable Conversation、Entries 或创建幂等键。 */
export async function renameUserConversation(
  harness: Harness,
  id: number,
  title: string,
  signal?: AbortSignal,
): Promise<UserConversation> {
  return harness.commit(async (tx) => {
    const index = await tx.doc(UserConversations);
    const conversation = index.items[String(id)];
    if (!conversation) {
      throw new RuntimeApplicationError("CONVERSATION_NOT_FOUND", "Conversation does not exist or is not visible.");
    }
    signal?.throwIfAborted();
    conversation.title = title;
    return { id: conversation.id, title: conversation.title, createdAt: conversation.createdAt,
      ...(conversation.forkedFrom ? { forkedFrom: { ...conversation.forkedFrom } } : {}) };
  }, BACKGROUND_CONTEXT);
}

/** 原生历史分支与用户索引在同一事务中创建，不复制消息或执行状态。 */
export async function forkUserConversation(
  harness: Harness,
  conversationId: number,
  entryId: number,
  requestId: string,
  signal?: AbortSignal,
): Promise<UserConversation> {
  return harness.commit(async (tx) => {
    const index = await tx.doc(UserConversations);
    const source = index.items[String(conversationId)];
    if (!source || !await tx.conversation(conversationId as ConversationId)) {
      throw new RuntimeApplicationError("CONVERSATION_NOT_FOUND", "Conversation does not exist or is not visible.");
    }
    const existingId = index.requests[requestId];
    if (existingId !== undefined) {
      const existing = index.items[String(existingId)];
      if (!existing) throw new Error("Conversation index is inconsistent");
      if (existing.forkedFrom?.conversationId !== conversationId || existing.forkedFrom.entryId !== entryId) {
        throw new RuntimeApplicationError("REQUEST_ID_CONFLICT", "Request ID belongs to another fork or operation.");
      }
      return { id: existing.id, title: existing.title, createdAt: existing.createdAt,
        forkedFrom: { conversationId, entryId } };
    }
    // 有界、fork-aware 查询同时排除其他会话和父分支截断点之后的 Entry。
    const page = await tx.scanEntries({ conversationId: conversationId as ConversationId,
      minEntryId: entryId as EntryId, maxEntryId: entryId as EntryId }, 1);
    const entry = page.items[0];
    if (entry?.kind !== "pi.assistant" || !entry.model?.some((message) =>
      message.role === "assistant" && (message.stopReason === "stop" || message.stopReason === "length"))) {
      throw new RuntimeApplicationError("FORK_ENTRY_INVALID", "Choose a completed assistant reply visible in this conversation.");
    }
    signal?.throwIfAborted();
    const created = await tx.forkConversation(conversationId as ConversationId, entryId as EntryId,
      { ownership: { kind: "ownerless" } });
    const conversation: UserConversation = { id: created.id, title: source.title.slice(0, 116) + "（分支）",
      createdAt: Date.now(), forkedFrom: { conversationId, entryId } };
    index.items[String(created.id)] = conversation;
    index.requests[requestId] = created.id;
    return conversation;
  }, BACKGROUND_CONTEXT);
}
