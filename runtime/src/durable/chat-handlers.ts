import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, ConversationBusy, LiveDoc, configure, type ConversationId, type SubmissionRecord, type Tx } from "@earendil-works/pi-durable";
import { z } from "zod";
import { RuntimeApplicationError } from "../protocol/errors.js";
import { RuntimeHandlerRegistry } from "../handlers/registry.js";
import { supportsConnectionTest } from "../handlers/provider-test.js";
import { getUserConversation } from "./conversations.js";
import type { DurableHost } from "./host.js";

const ConversationParams = z.object({ conversationId: z.number().int().positive() }).strict();
const SubmitParams = ConversationParams.extend({
  requestId: z.uuid(), providerId: z.string().trim().min(1).max(128),
  modelId: z.string().trim().min(1).max(256), content: z.string().trim().min(1).max(8000),
});
const ResumeParams = ConversationParams.extend({ requestId: z.uuid() });
const resumableReasons = new Set(["aborted", "model_error", "interrupted", "restart_limit", "no_model"]);

export function registerChatHandlers(registry: RuntimeHandlerRegistry, host: DurableHost): void {
  async function visible(id: number) {
    if (!await getUserConversation(host.harness, id)) throw new RuntimeApplicationError("CONVERSATION_NOT_FOUND", "Conversation is not visible.");
    const conversation = await host.conversation(id as ConversationId);
    if (!conversation) throw new RuntimeApplicationError("CONVERSATION_NOT_FOUND", "Conversation does not exist.");
    return conversation;
  }
  function params<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new RuntimeApplicationError("INVALID_PARAMS", "Invalid chat parameters.");
    return parsed.data;
  }
  async function checkModel(providerId: string, modelId: string, signal: AbortSignal) {
    const model = host.models.getModel(providerId, modelId);
    if (!model) throw new RuntimeApplicationError("MODEL_NOT_FOUND", "Model is unavailable.");
    if (!supportsConnectionTest(model.api)) throw new RuntimeApplicationError("CHAT_UNSUPPORTED", "Model API is not supported for chat.");
    let auth;
    try { auth = await host.models.checkAuth(providerId, { signal }); }
    catch { throw new RuntimeApplicationError("CREDENTIAL_STORE_UNAVAILABLE", "Provider credentials are unavailable."); }
    if (!auth) throw new RuntimeApplicationError("PROVIDER_NOT_CONFIGURED", "Provider authentication is not configured.");
    if (auth.type !== "api_key") throw new RuntimeApplicationError("CHAT_UNSUPPORTED", "Chat currently requires API key authentication.");
  }
  registry.register("conversation.chat.submit", async (request, context) => {
    const input = params(SubmitParams, request.params);
    const conversation = await visible(input.conversationId);
    async function existing(tx: Tx): Promise<SubmissionRecord | undefined> {
      const prior = await tx.submissionByRequest(conversation.id, input.requestId);
      if (!prior) return undefined;
      const entry = prior.entry ? await tx.entry(prior.entry) : undefined;
      const metadata = entry?.data;
      if (prior.type !== "input" || !metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
        metadata.providerId !== input.providerId || metadata.modelId !== input.modelId || entry?.model?.[0]?.role !== "user" || entry.model[0].content !== input.content) {
        throw new RuntimeApplicationError("REQUEST_ID_CONFLICT", "Request id was used for another input.");
      }
      return prior;
    }
    // 原生 requestId 去重不依赖当前凭据或模型目录是否仍可用。
    const prior = await host.harness.commit(existing, BACKGROUND_CONTEXT);
    if (prior) return { submissionId: prior.id };
    await checkModel(input.providerId, input.modelId, context.signal);
    try {
      const submissionId = await host.harness.commit(async (tx) => {
        context.signal.throwIfAborted();
        const concurrent = await existing(tx);
        if (concurrent) return concurrent.id;
        const id = await conversation.submit(tx, {
          type: "input", requestId: input.requestId, content: input.content, whenBusy: "reject",
          entry: { kind: "studio.chat-input", data: { providerId: input.providerId, modelId: input.modelId } },
        });
        await configure(tx, conversation.id, {
          model: { provider: input.providerId, modelId: input.modelId },
          tools: [], extensions: [], modelTools: [], thinkingLevel: "off", maxTurns: 1,
        });
        return id;
      }, BACKGROUND_CONTEXT);
      // IPC 只等待提交落盘，不等待模型生成；调度仍由 Harness 完成。
      host.harness.resume();
      context.emit("conversation.chat.submitted", { conversationId: conversation.id, submissionId });
      return { submissionId };
    } catch (cause) {
      if (cause instanceof ConversationBusy) throw new RuntimeApplicationError("CONVERSATION_BUSY", "Conversation is already running.");
      throw cause;
    }
  });

  registry.register("conversation.chat.resume", async (request, context) => {
    const input = params(ResumeParams, request.params);
    const conversation = await visible(input.conversationId);
    async function admission(tx: Tx) {
      const prior = await tx.submissionByRequest(conversation.id, input.requestId);
      if (prior) {
        if (prior.type !== "continue") throw new RuntimeApplicationError("REQUEST_ID_CONFLICT", "Request id belongs to another operation.");
        return { prior, model: undefined };
      }
      const live = await tx.doc(LiveDoc, conversation.id);
      if (live.run) throw new RuntimeApplicationError("CONVERSATION_BUSY", "Conversation is already running.");
      if (!live.runFailure || !resumableReasons.has(live.runFailure.reason)) {
        throw new RuntimeApplicationError("CHAT_NOT_RESUMABLE", "Conversation has no failed or stopped answer to resume.");
      }
      const agent = await tx.doc(AgentDoc, conversation.id);
      if (!agent.model) throw new RuntimeApplicationError("MODEL_NOT_FOUND", "Conversation model is not configured.");
      return { prior: undefined, model: { ...agent.model } };
    }
    const initial = await host.harness.commit(admission, BACKGROUND_CONTEXT);
    if (initial.prior) return { submissionId: initial.prior.id };
    const model = initial.model;
    if (!model) throw new RuntimeApplicationError("MODEL_NOT_FOUND", "Conversation model is unavailable.");
    await checkModel(model.provider, model.modelId, context.signal);
    try {
      const submissionId = await host.harness.commit(async (tx) => {
        context.signal.throwIfAborted();
        const current = await admission(tx);
        if (current.prior) return current.prior.id;
        if (current.model?.provider !== model.provider || current.model.modelId !== model.modelId) {
          throw new RuntimeApplicationError("CHAT_NOT_RESUMABLE", "Conversation changed; refresh its state.");
        }
        return conversation.submit(tx, { type: "continue", requestId: input.requestId });
      }, BACKGROUND_CONTEXT);
      host.harness.resume();
      context.emit("conversation.chat.submitted", { conversationId: conversation.id, submissionId });
      return { submissionId };
    } catch (cause) {
      if (cause instanceof ConversationBusy) throw new RuntimeApplicationError("CONVERSATION_BUSY", "Conversation is already running.");
      throw cause;
    }
  });

  registry.register("conversation.chat.status", async (request) => {
    const { conversationId } = params(ConversationParams, request.params);
    const conversation = await visible(conversationId);
    return host.harness.commit(async (tx) => {
      const latest = await tx.latestEntryId(conversation.id);
      const agent = await tx.doc(AgentDoc, conversation.id);
      const live = await tx.doc(LiveDoc, conversation.id);
      return {
        conversationId, running: Boolean(live.run), latestEntryId: latest ?? null,
        model: agent.model ? { providerId: agent.model.provider, modelId: agent.model.modelId } : null,
        failureReason: live.runFailure?.reason ?? null,
        canResume: !live.run && Boolean(live.runFailure && resumableReasons.has(live.runFailure.reason)),
        partialText: live.generation?.message?.content.filter((item) => item.type === "text").map((item) => item.text).join("").slice(0, 12000) ?? "",
      };
    }, BACKGROUND_CONTEXT);
  });
  registry.register("conversation.chat.abort", async (request) => {
    const { conversationId } = params(ConversationParams, request.params);
    const conversation = await visible(conversationId);
    await conversation.abort(BACKGROUND_CONTEXT);
    return { conversationId, stopped: true };
  });
}
