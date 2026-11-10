
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  defineDoc,
  type Harness,
} from "@earendil-works/pi-durable";

export type UserConversation  = {
  id: number;
  title: string;
  createdAt: number;
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
): Promise<{
  items: UserConversation[];
  nextBeforeId: number | null;
}> {
  const index = await harness.snapshot(
    UserConversations,
    BACKGROUND_CONTEXT,
  );

  const sorted = Object.values(index?.items ?? {})
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
