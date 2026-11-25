
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { UsageDoc, type ConversationId } from "@earendil-works/pi-durable";
import { z } from "zod";

import { RuntimeApplicationError } from "../protocol/errors.js";
import { RuntimeHandlerRegistry } from "../handlers/registry.js";

import { DurableHost } from "./host.js";
import {
  createUserConversation,
  getUserConversation,
  listUserConversations,
  renameUserConversation,
} from "./conversations.js";

const CreateParams = z.object({
  requestId: z.uuid(),
  title: z.string().trim().min(1).max(120)
    .default("新建会话"),
}).strict();

const ListParams = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  beforeId: z.number().int().positive().optional(),
  query: z.string().trim().max(120).default(""),
}).strict();

const RenameParams = z.object({
  conversationId: z.number().int().positive(),
  title: z.string().trim().min(1).max(120),
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

const UsageParams = z.object({
  conversationId: z.number().int().positive(),
  limit: z.number().int().min(1).max(50).default(20),
  afterModel: z.string().min(1).max(1024).optional(),
}).strict();

const tokenCount = (value: number | undefined): number | null =>
  value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : null;

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
      parsed.data.query,
    );
  });

  registry.register("conversation.rename", async (request, context) => {
    const parsed = RenameParams.safeParse(request.params);
    if (!parsed.success) throw invalidParams("conversation.rename");
    const conversation = await renameUserConversation(
      host.harness, parsed.data.conversationId, parsed.data.title, context.signal,
    );
    context.emit("conversation.renamed", { conversationId: conversation.id });
    return { conversation };
  });

  registry.register("conversation.usage", async (request) => {
    const parsed = UsageParams.safeParse(request.params);
    if (!parsed.success) throw invalidParams("conversation.usage");
    const { conversationId, limit, afterModel } = parsed.data;
    if (!await getUserConversation(host.harness, conversationId) || !await host.conversation(conversationId as ConversationId)) {
      throw new RuntimeApplicationError("CONVERSATION_NOT_FOUND", "Conversation does not exist or is not visible.");
    }
    // 原生账本已包含完整历史与失败尝试；这里只做只读投影，不扫描或重新累计 Entry。
    const usage = await host.harness.snapshot(UsageDoc, conversationId as ConversationId, BACKGROUND_CONTEXT);
    const models = Object.keys(usage?.models ?? {}).sort().filter((key) => afterModel === undefined || key > afterModel);
    const page = models.slice(0, limit);
    return {
      items: page.map((model) => {
        const value = usage!.models[model]!;
        return {
          model, inputTokens: tokenCount(value.input), outputTokens: tokenCount(value.output),
          cacheReadTokens: tokenCount(value.cacheRead), cacheWriteTokens: tokenCount(value.cacheWrite),
          reasoningTokens: tokenCount(value.reasoning), totalTokens: tokenCount(value.totalTokens),
          costUsd: Number.isFinite(value.cost.total) && value.cost.total > 0 ? value.cost.total : null,
        };
      }),
      nextAfterModel: models.length > page.length ? page.at(-1) ?? null : null,
    };
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
