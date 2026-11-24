import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { LiveDoc, type ConversationId, type SubmissionId } from "@earendil-works/pi-durable";
import { DurableHost } from "./host.js";
import { createUserConversation } from "./conversations.js";
import { registerChatHandlers } from "./chat-handlers.js";
import { configuredProvider, writeProviderConfig } from "./provider-config.js";
import { RuntimeHandlerRegistry } from "../handlers/registry.js";
import { RuntimeRequestDispatcher } from "../handlers/dispatcher.js";

async function fixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "pi-studio-chat-"));
  const credentials = new InMemoryCredentialStore();
  let mode: "success" | "error" | "slow" = "success";
  const calls: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as Record<string, unknown>;
    calls.push(body);
    if (mode === "error") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "synthetic-chat-secret", type: "invalid_request_error" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const write = (content: string, reason: string | null) => response.write(`data: ${JSON.stringify({ id: "chat-local", object: "chat.completion.chunk", created: 1, model: "chat-model", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: reason }] })}\n\n`);
    write("本地回复", null);
    if (mode !== "slow") { write("完成", "stop"); response.end("data: [DONE]\n\n"); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let host = await DurableHost.open(directory, credentials);
  context.after(async () => {
    await host.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const config = { id: "custom-chat", name: "Chat test", baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: "chat-model", contextWindow: 32768, maxTokens: 4096 };
  await writeProviderConfig(host.harness, config, new AbortController().signal);
  host.models.setProvider(configuredProvider(config));
  await credentials.modify(config.id, async () => ({ type: "api_key", key: "synthetic-chat-secret" }));
  const conversation = await createUserConversation(host.harness, randomUUID(), "Chat test");
  function request(method: string, params: Record<string, unknown>) {
    const registry = new RuntimeHandlerRegistry();
    registerChatHandlers(registry, host);
    const id = randomUUID();
    return new RuntimeRequestDispatcher(registry).dispatch({ version: 1, kind: "request", id, method, params }, {
      requestId: id, receivedAt: Date.now(), signal: new AbortController().signal, emit: () => {},
    });
  }
  async function settled(id: unknown) {
    assert.equal(typeof id, "number");
    const submission = await host.harness.submission(id as SubmissionId, BACKGROUND_CONTEXT);
    assert.ok(submission);
    return submission.wait(BACKGROUND_CONTEXT);
  }
  return {
    get host() { return host; }, credentials, conversation, config, calls, request, settled,
    setMode(next: typeof mode) { mode = next; },
    input(content = "你好") { return { conversationId: conversation.id, requestId: randomUUID(), providerId: config.id, modelId: config.modelId, content }; },
    async reopen() { await host.close(); host = await DurableHost.open(directory, credentials); },
  };
}

test("native chat submits idempotently, carries context and restores transcript and model after reopen", { timeout: 20_000 }, async (context) => {
  const f = await fixture(context);
  const input = f.input();
  const [first, duplicate] = await Promise.all([
    f.request("conversation.chat.submit", input), f.request("conversation.chat.submit", input),
  ]);
  assert.ok(first.success && duplicate.success);
  assert.equal(first.result.submissionId, duplicate.result.submissionId);
  assert.equal((await f.settled(first.result.submissionId)).status, "done");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]?.max_tokens, 2048);
  assert.equal(f.calls[0]?.tools, undefined);
  const second = await f.request("conversation.chat.submit", f.input("再说一句"));
  assert.ok(second.success);
  assert.equal((await f.settled(second.result.submissionId)).status, "done");
  assert.ok(JSON.stringify(f.calls[1]?.messages).includes("本地回复完成"));
  await f.reopen();
  const status = await f.request("conversation.chat.status", { conversationId: f.conversation.id });
  assert.ok(status.success);
  assert.equal(status.result.running, false);
  assert.deepEqual(status.result.model, { providerId: f.config.id, modelId: f.config.modelId });
  const conversation = await f.host.conversation(f.conversation.id as ConversationId);
  assert.ok(conversation);
  const entries = await conversation.entries({ order: "ascending" }, 20, undefined, BACKGROUND_CONTEXT);
  assert.equal(entries.items.filter((entry) => entry.kind === "studio.chat-input").length, 2);
  assert.equal(entries.items.filter((entry) => entry.kind === "pi.assistant").length, 2);
  await f.credentials.delete(f.config.id);
  const retry = await f.request("conversation.chat.submit", input);
  assert.ok(retry.success);
  assert.equal(retry.result.submissionId, first.result.submissionId);
  assert.equal(f.calls.length, 2);
  const conflict = await f.request("conversation.chat.submit", { ...input, content: "different" });
  assert.ok(!conflict.success);
  assert.equal(conflict.error.code, "REQUEST_ID_CONFLICT");
});

test("chat rejects busy conversation and native abort stops its generation", { timeout: 20_000 }, async (context) => {
  const f = await fixture(context);
  f.setMode("slow");
  const first = await f.request("conversation.chat.submit", f.input());
  assert.ok(first.success);
  const busy = await f.request("conversation.chat.submit", f.input("second"));
  assert.ok(!busy.success);
  assert.equal(busy.error.code, "CONVERSATION_BUSY");
  const abort = await f.request("conversation.chat.abort", { conversationId: f.conversation.id });
  assert.ok(abort.success);
  assert.equal((await f.settled(first.result.submissionId)).status, "unanswered");
  const status = await f.request("conversation.chat.status", { conversationId: f.conversation.id });
  assert.ok(status.success);
  assert.equal(status.result.running, false);
  assert.equal(status.result.failureReason, "aborted");
});

test("upstream authentication errors are sanitized before Durable stores entries, status and task outcome", { timeout: 20_000 }, async (context) => {
  const f = await fixture(context);
  f.setMode("error");
  const submitted = await f.request("conversation.chat.submit", f.input());
  assert.ok(submitted.success);
  assert.equal((await f.settled(submitted.result.submissionId)).status, "unanswered");
  const conversation = await f.host.conversation(f.conversation.id as ConversationId);
  assert.ok(conversation);
  const entries = await conversation.entries({}, 20, undefined, BACKGROUND_CONTEXT);
  const status = await f.request("conversation.chat.status", { conversationId: f.conversation.id });
  const inspected = await f.host.harness.inspect(BACKGROUND_CONTEXT);
  const live = await f.host.harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT);
  assert.ok(live?.runFailure);
  const task = await f.host.harness.getTask(live.runFailure.taskId, BACKGROUND_CONTEXT);
  assert.equal(task?.state.status, "terminal");
  assert.equal(JSON.stringify([entries, status, inspected, task]).includes("synthetic-chat-secret"), false);
  assert.ok(status.success);
  assert.equal(status.result.failureReason, "model_error");
  assert.equal(f.calls.length, 1, "Failed authentication is not retried");
});

test("chat validates parameters, credentials and user visibility without creating a model request", { timeout: 20_000 }, async (context) => {
  const f = await fixture(context);
  const root = await f.host.root();
  for (const method of ["conversation.chat.submit", "conversation.chat.status", "conversation.chat.abort", "conversation.chat.resume"]) {
    const input = method.endsWith("submit") ? { ...f.input(), conversationId: root.id } : method.endsWith("resume") ? { conversationId: root.id, requestId: randomUUID() } : { conversationId: root.id };
    const hidden = await f.request(method, input);
    assert.ok(!hidden.success);
    assert.equal(hidden.error.code, "CONVERSATION_NOT_FOUND");
  }
  for (const input of [{ ...f.input(), content: "" }, { ...f.input(), content: "a".repeat(8001) }, { ...f.input(), apiKey: "synthetic" }]) {
    const invalid = await f.request("conversation.chat.submit", input);
    assert.ok(!invalid.success);
    assert.equal(invalid.error.code, "INVALID_PARAMS");
  }
  await f.credentials.delete(f.config.id);
  const missing = await f.request("conversation.chat.submit", f.input());
  assert.ok(!missing.success);
  assert.equal(missing.error.code, "PROVIDER_NOT_CONFIGURED");
  assert.equal(f.calls.length, 0);
});

test("failed generation resumes through native continue without duplicating user entries, including concurrent retries", { timeout: 20_000 }, async (context) => {
  const f = await fixture(context);
  f.setMode("error");
  const originalInput = f.input("失败后继续的原消息");
  const first = await f.request("conversation.chat.submit", originalInput);
  assert.ok(first.success);
  assert.equal((await f.settled(first.result.submissionId)).status, "unanswered");
  await f.reopen();
  const status = await f.request("conversation.chat.status", { conversationId: f.conversation.id });
  assert.ok(status.success);
  assert.equal(status.result.canResume, true);
  f.setMode("success");
  const input = { conversationId: f.conversation.id, requestId: randomUUID() };
  const [resumed, duplicate] = await Promise.all([
    f.request("conversation.chat.resume", input), f.request("conversation.chat.resume", input),
  ]);
  assert.ok(resumed.success && duplicate.success);
  assert.equal(resumed.result.submissionId, duplicate.result.submissionId);
  const settled = await f.settled(resumed.result.submissionId);
  assert.equal(settled.type, "continue");
  assert.equal(settled.status, "done");
  assert.equal(f.calls.length, 2);
  assert.ok(JSON.stringify(f.calls[1]?.messages).includes(originalInput.content));
  const conversation = await f.host.conversation(f.conversation.id as ConversationId);
  assert.ok(conversation);
  const entries = await conversation.entries({}, 20, undefined, BACKGROUND_CONTEXT);
  assert.equal(entries.items.filter((entry) => entry.kind === "studio.chat-input").length, 1);
  await f.credentials.delete(f.config.id);
  const retry = await f.request("conversation.chat.resume", input);
  assert.ok(retry.success);
  assert.equal(retry.result.submissionId, resumed.result.submissionId);
  const conflict = await f.request("conversation.chat.resume", { ...input, requestId: originalInput.requestId });
  assert.ok(!conflict.success);
  assert.equal(conflict.error.code, "REQUEST_ID_CONFLICT");
});

test("stopped generation can continue, while empty, answered and busy conversations reject new continue requests", { timeout: 20_000 }, async (context) => {
  const f = await fixture(context);
  const resume = () => f.request("conversation.chat.resume", { conversationId: f.conversation.id, requestId: randomUUID() });
  const empty = await resume();
  assert.ok(!empty.success);
  assert.equal(empty.error.code, "CHAT_NOT_RESUMABLE");
  f.setMode("slow");
  const first = await f.request("conversation.chat.submit", f.input());
  assert.ok(first.success);
  while (f.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  const busy = await resume();
  assert.ok(!busy.success);
  assert.equal(busy.error.code, "CONVERSATION_BUSY");
  assert.ok((await f.request("conversation.chat.abort", { conversationId: f.conversation.id })).success);
  await f.settled(first.result.submissionId);
  f.setMode("success");
  const resumed = await resume();
  assert.ok(resumed.success);
  assert.equal((await f.settled(resumed.result.submissionId)).status, "done");
  const answered = await resume();
  assert.ok(!answered.success);
  assert.equal(answered.error.code, "CHAT_NOT_RESUMABLE");
  const status = await f.request("conversation.chat.status", { conversationId: f.conversation.id });
  assert.ok(status.success);
  assert.equal(status.result.canResume, false);
  assert.equal(f.calls.length, 2);
});

test("independent conversations keep their contexts and native run cancellation separate", { timeout: 20_000 }, async (context) => {
  const f = await fixture(context);
  f.setMode("slow");
  const first = await f.request("conversation.chat.submit", f.input("独立会话甲"));
  assert.ok(first.success);
  while (f.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  f.setMode("success");
  const secondConversation = await createUserConversation(f.host.harness, randomUUID(), "Other");
  const second = await f.request("conversation.chat.submit", { ...f.input("独立会话乙"), conversationId: secondConversation.id });
  assert.ok(second.success);
  assert.equal((await f.settled(second.result.submissionId)).status, "done");
  assert.ok(JSON.stringify(f.calls[1]?.messages).includes("独立会话乙"));
  assert.equal(JSON.stringify(f.calls[1]?.messages).includes("独立会话甲"), false);
  const firstStatus = await f.request("conversation.chat.status", { conversationId: f.conversation.id });
  assert.ok(firstStatus.success);
  assert.equal(firstStatus.result.running, true);
  assert.ok((await f.request("conversation.chat.abort", { conversationId: f.conversation.id })).success);
  const secondStatus = await f.request("conversation.chat.status", { conversationId: secondConversation.id });
  assert.ok(secondStatus.success);
  assert.equal(secondStatus.result.failureReason, null);
});

test("reopen resumes a paused native run without admitting the user input twice", { timeout: 20_000 }, async (context) => {
  const f = await fixture(context);
  f.setMode("slow");
  const input = f.input("重启期间的消息");
  const submitted = await f.request("conversation.chat.submit", input);
  assert.ok(submitted.success);
  while (f.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  f.setMode("success");
  await f.reopen();
  const settled = await f.settled(submitted.result.submissionId);
  assert.equal(settled.status, "done");
  assert.equal(f.calls.length, 2, "A gracefully paused request resumes through Durable, rather than a new submission");
  const retry = await f.request("conversation.chat.submit", input);
  assert.ok(retry.success);
  assert.equal(retry.result.submissionId, submitted.result.submissionId);
  const conversation = await f.host.conversation(f.conversation.id as ConversationId);
  assert.ok(conversation);
  const entries = await conversation.entries({}, 20, undefined, BACKGROUND_CONTEXT);
  assert.equal(entries.items.filter((entry) => entry.kind === "studio.chat-input").length, 1);
});
