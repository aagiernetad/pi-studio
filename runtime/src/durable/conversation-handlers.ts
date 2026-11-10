
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { z } from "zod";

import { RuntimeApplicationError } from "../protocol/errors.js";
import { RuntimeHandlerRegistry } from "../handlers/registry.js";

import { DurableHost } from "./host.js";
import {
  createUserConversation,
  getUserConversation,
  listUserConversations,
} from "./conversations.js";

const CreateParams = z.object({
  requestId: z.uuid(),
  title: z.string().trim().min(1).max(120)
    .default("新建会话"),
}).strict();

const ListParams = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  beforeId: z.number().int().positive().optional(),
}).strict();

const GetParams = z.object({
  conversationId: z.number().int().positive(),
}).strict();

const EntriesParams = z.object({
  conversationId: z.number().int().positive(),
  limit: z.number().int().min(1).max(20).default(10),

  // Durable 原生 Storage Cursor，属于不透明 JSON 对象
  cursor: z.record(z.string(), z.json()).optional(),
}).strict();

function invalidParams(method: string): RuntimeApplicationError {
  return new RuntimeApplicationError(
    "INVALID_PARAMS",
    `Invalid ${method} parameters.`,
  );
}

export function registerConversationHandlers(
  registry: RuntimeHandlerRegistry,
  host: DurableHost,
): void {

  registry.register("conversation.create", async (request) => {
    const parsed = CreateParams.safeParse(request.params);

    if (!parsed.success) {
      throw invalidParams("conversation.create");
    }

    const conversation = await createUserConversation(
      host.harness,
      parsed.data.requestId,
      parsed.data.title,
    );

    return { conversation };
  });

  registry.register("conversation.list", async (request) => {
    const parsed = ListParams.safeParse(request.params);

    if (!parsed.success) {
      throw invalidParams("conversation.list");
    }

    return listUserConversations(
      host.harness,
      parsed.data.limit,
      parsed.data.beforeId,
    );
  });

  registry.register("conversation.get", async (request) => {
    const parsed = GetParams.safeParse(request.params);

    if (!parsed.success) {
      throw invalidParams("conversation.get");
    }

    const conversation = await getUserConversation(
      host.harness,
      parsed.data.conversationId,
    );

    if (!conversation) {
      throw new RuntimeApplicationError(
        "CONVERSATION_NOT_FOUND",
        "Conversation does not exist or is not visible.",
      );
    }

    return { conversation };
  });

  // 从真实 Durable Transcript 读取历史
  registry.register("conversation.entries", async (request) => {
    const parsed = EntriesParams.safeParse(request.params);

    if (!parsed.success) {
      throw invalidParams("conversation.entries");
    }

    const { conversationId, limit, cursor } = parsed.data;

    // 先检查 Studio 用户可见性
    const visible = await getUserConversation(
      host.harness,
      conversationId,
    );

    if (!visible) {
      throw new RuntimeApplicationError(
        "CONVERSATION_NOT_FOUND",
        "Conversation does not exist or is not visible.",
      );
    }

    // 获取真实 Durable Conversation
    const conversation = await host.conversation(
      conversationId as ConversationId,
    );

    if (!conversation) {
      throw new RuntimeApplicationError(
        "CONVERSATION_NOT_FOUND",
        "Conversation no longer exists.",
      );
    }

    // 使用 Durable 原生分页，最新记录优先
    const page = await conversation.entries(
      { order: "descending" },
      limit,
      cursor,
      BACKGROUND_CONTEXT,
    );

    // 不暴露整个 Durable 内部对象
    const result = {
      items: page.items.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        data: entry.data ?? null,
        model: entry.model ?? null,
      })),
      nextCursor: page.next ?? null,
    };

    // 避免大响应超过目前 Rust IPC 的单行上限
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > 512 * 1024) {
      throw new RuntimeApplicationError(
        "RESPONSE_TOO_LARGE",
        "Transcript page is too large; reduce the page size.",
      );
    }

    return result;
  });
}
