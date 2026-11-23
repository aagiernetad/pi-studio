import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";

import { InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";

import { RuntimeRequestDispatcher } from "./dispatcher.js";
import { registerProviderTestHandlers } from "./provider-test.js";
import { RuntimeHandlerRegistry } from "./registry.js";
import { JsonlServer } from "../server/jsonl-server.js";
import { RuntimeResponseSchema } from "../protocol/messages.js";
import { RuntimeApplicationError } from "../protocol/errors.js";

async function setup(timeoutMs = 8_000) {
  const credentials = new InMemoryCredentialStore();
  const key = "synthetic-provider-test-key";
  await credentials.modify("deepseek", async () => ({ type: "api_key", key }));
  const models = builtinModels({
    credentials,
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  const model = models.getModels("deepseek")[0];
  assert.ok(model);
  const registry = new RuntimeHandlerRegistry();
  registerProviderTestHandlers(registry, models, timeoutMs);
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const dispatcher = new RuntimeRequestDispatcher(registry);
  const params = { providerId: "deepseek", modelId: model.id };
  function request(input: Record<string, unknown> = params, signal = new AbortController().signal) {
    const id = randomUUID();
    return dispatcher.dispatch({ version: 1, kind: "request", id, method: "provider.test", params: input }, {
      requestId: id, receivedAt: Date.now(), signal,
      emit: (event, data) => { if (!signal.aborted) events.push({ event, data }); },
    });
  }
  return { models, credentials, key, registry, dispatcher, params, events, request };
}

test("connection test uses the shared Models with a fixed bounded request", async (context) => {
  const { models, request, params, events } = await setup();
  const complete = context.mock.method(models, "completeSimple", async (..._args: Parameters<typeof models.completeSimple>) => fauxAssistantMessage("private-model-output"));
  const response = await request();
  assert.ok(response.success);
  assert.equal(response.result.connected, true);
  assert.equal(typeof response.result.durationMs, "number");
  assert.deepEqual(Object.keys(response.result).sort(), ["connected", "durationMs", "modelId", "providerId"]);
  assert.equal(complete.mock.callCount(), 1);
  const args = complete.mock.calls[0]?.arguments;
  assert.ok(args && args[0] && args[1]);
  assert.equal(args[0].id, params.modelId);
  assert.equal(args[1].messages.length, 1);
  assert.equal(args[1].messages[0]?.role, "user");
  assert.equal(args[1].messages[0]?.content, "Reply with OK.");
  assert.equal(args[1].tools, undefined);
  assert.equal(args[2]?.maxTokens, 16);
  assert.equal(args[2]?.maxRetries, 0);
  assert.equal(args[2]?.reasoning, undefined);
  assert.equal(args[2]?.transport, "sse");
  assert.equal(args[2]?.timeoutMs, 8_000);
  assert.throws(() => args[2]?.onPayload?.({ max_tokens: 8192 }, args[0]));
  assert.throws(() => args[2]?.onPayload?.({}, args[0]));
  assert.doesNotThrow(() => args[2]?.onPayload?.({ max_tokens: 16 }, args[0]));
  assert.equal(JSON.stringify([response, events]).includes("private-model-output"), false);
  assert.deepEqual(events, [{ event: "provider.tested", data: { ...params, connected: true } }]);
});

test("connection test rejects invalid parameters, unknown models and missing authentication", async (context) => {
  const { models, credentials, request, params } = await setup();
  const complete = context.mock.method(models, "completeSimple", async () => { throw new Error("must not run"); });
  for (const input of [{}, { providerId: "" }, { ...params, modelId: "" }, { ...params, modelId: 1 }, { ...params, apiKey: "synthetic" }, { ...params, prompt: "arbitrary input" }]) {
    const response = await request(input);
    assert.ok(!response.success);
    assert.equal(response.error.code, "INVALID_PARAMS");
  }
  const unknownProvider = await request({ ...params, providerId: "unknown" });
  assert.ok(!unknownProvider.success);
  assert.equal(unknownProvider.error.code, "PROVIDER_NOT_FOUND");
  const unknownModel = await request({ ...params, modelId: "unknown" });
  assert.ok(!unknownModel.success);
  assert.equal(unknownModel.error.code, "MODEL_NOT_FOUND");
  await credentials.delete("deepseek");
  const missing = await request();
  assert.ok(!missing.success);
  assert.equal(missing.error.code, "PROVIDER_NOT_CONFIGURED");
  assert.equal(complete.mock.callCount(), 0);
});

test("connection test reports unsupported model APIs and OAuth without calling a model", async (context) => {
  const { models, request, params } = await setup();
  const complete = context.mock.method(models, "completeSimple", async () => { throw new Error("must not run"); });
  const provider = models.getProvider("deepseek");
  assert.ok(provider);
  const originalModels = provider.getModels();
  models.setProvider({ ...provider, getModels: () => originalModels.map((model) => ({ ...model, api: "unverified-api" })) });
  const unsupported = await request(params);
  assert.ok(!unsupported.success);
  assert.equal(unsupported.error.code, "PROVIDER_TEST_UNSUPPORTED");
  models.setProvider(provider);
  context.mock.method(models, "checkAuth", async () => ({ type: "oauth", source: "OAuth" }));
  const oauth = await request();
  assert.ok(!oauth.success);
  assert.equal(oauth.error.code, "PROVIDER_TEST_UNSUPPORTED");
  assert.equal(complete.mock.callCount(), 0);
});

test("connection failures and upstream text never leak into JSONL responses or logs", async (context) => {
  const { models, dispatcher, params, key } = await setup();
  context.mock.method(models, "completeSimple", async () => fauxAssistantMessage("", {
    stopReason: "error", errorMessage: `upstream echoed ${key}`,
  }));
  const output: string[] = [];
  const logs: string[] = [];
  const server = new JsonlServer(dispatcher, {
    input: Readable.from([JSON.stringify({ version: 1, kind: "request", id: "test", method: "provider.test", params }) + "\n"]),
    output: new Writable({ write(chunk, _encoding, callback) { output.push(chunk.toString()); callback(); } }),
    log: (message) => { logs.push(message); },
  });
  await server.run();
  assert.equal(output.join("").includes(key) || logs.join("\n").includes(key), false);
  const response = output.join("").trim().split("\n")
    .map((line) => RuntimeResponseSchema.safeParse(JSON.parse(line)))
    .find((parsed) => parsed.success);
  assert.ok(response?.success && !response.data.success);
  assert.equal(response.data.error.code, "PROVIDER_TEST_FAILED");
  context.mock.method(models, "completeSimple", async () => { throw new RuntimeApplicationError("UPSTREAM_ERROR", key); });
  const thrown = await dispatcher.dispatch({ version: 1, kind: "request", id: "thrown", method: "provider.test", params }, {
    requestId: "thrown", receivedAt: Date.now(), signal: new AbortController().signal, emit: () => {},
  });
  assert.ok(!thrown.success);
  assert.equal(thrown.error.code, "PROVIDER_TEST_FAILED");
  assert.equal(JSON.stringify(thrown).includes(key), false);
});

test("connection test reaches a local OpenAI-compatible endpoint using pi-ai", { timeout: 20_000 }, async (context) => {
  const { models, request, params, key } = await setup();
  const requests: { path: string | undefined; authorized: boolean; body: Record<string, unknown> }[] = [];
  let mode: "success" | "redirect" | "auth-error" = "success";
  const server = createServer(async (incoming, outgoing) => {
    let body = "";
    for await (const chunk of incoming) body += chunk.toString();
    requests.push({ path: incoming.url, authorized: incoming.headers.authorization === `Bearer ${key}`, body: JSON.parse(body) });
    if (mode === "redirect") {
      outgoing.writeHead(307, { location: "/redirect-target" });
      outgoing.end();
      return;
    }
    if (mode === "auth-error") {
      outgoing.writeHead(401, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ error: { message: key, type: "invalid_request_error" } }));
      return;
    }
    outgoing.writeHead(200, { "content-type": "text/event-stream" });
    for (const choice of [
      { index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null },
      { index: 0, delta: {}, finish_reason: "stop" },
    ]) {
      outgoing.write(`data: ${JSON.stringify({ id: "local-test", object: "chat.completion.chunk", created: 1, model: params.modelId, choices: [choice] })}\n\n`);
    }
    outgoing.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const provider = models.getProvider("deepseek");
  assert.ok(provider);
  const localModels = provider.getModels().map((model) => ({ ...model, baseUrl }));
  models.setProvider({ ...provider, baseUrl, getModels: () => localModels });
  const response = await request();
  assert.ok(response.success);
  assert.equal(response.result.connected, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.path, "/v1/chat/completions");
  assert.ok(requests[0]?.authorized);
  assert.equal(requests[0]?.body.model, params.modelId);
  assert.ok(requests[0]?.body.max_tokens === 16 || requests[0]?.body.max_completion_tokens === 16);
  mode = "redirect";
  const redirected = await request();
  assert.ok(!redirected.success);
  assert.equal(redirected.error.code, "PROVIDER_TEST_FAILED");
  assert.equal(requests.length, 2, "Redirect target must not be requested");
  mode = "auth-error";
  const rejected = await request();
  assert.ok(!rejected.success);
  assert.equal(rejected.error.code, "PROVIDER_TEST_FAILED");
  assert.equal(JSON.stringify(rejected).includes(key), false);
  assert.equal(requests.length, 3, "Authentication failure must not be retried");
  mode = "success";
  models.setProvider({
    ...provider, baseUrl,
    getModels: () => localModels.map((model) => ({ ...model, samplingParams: { max_tokens: 8192 } })),
  });
  const unbounded = await request();
  assert.ok(!unbounded.success);
  assert.equal(unbounded.error.code, "PROVIDER_TEST_FAILED");
  assert.equal(requests.length, 3, "A model override must not bypass the test output budget");
});

test("connection test timeout and caller cancellation abort the model operation", async (context) => {
  const { models, request, params, events } = await setup(25);
  let started!: () => void;
  let aborted = 0;
  let entered = new Promise<void>((resolve) => { started = resolve; });
  context.mock.method(models, "completeSimple", (...[_model, _input, options]: Parameters<typeof models.completeSimple>) => new Promise<AssistantMessage>((_resolve, reject) => {
    const signal = options?.signal;
    assert.ok(signal);
    const cancel = () => { aborted++; reject(new Error("synthetic-private-abort")); };
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
    started();
  }));
  // AbortSignal.timeout 的计时器不保持进程存活；测试以一个有界计时器维持等待。
  const keepAlive = setTimeout(() => {}, 2_000);
  try {
    const timeout = await request();
    assert.ok(!timeout.success);
    assert.equal(timeout.error.code, "PROVIDER_TEST_TIMEOUT");
    assert.equal(aborted, 1);
    entered = new Promise<void>((resolve) => { started = resolve; });
    const controller = new AbortController();
    const pending = request(params, controller.signal);
    await entered;
    controller.abort();
    const cancelled = await pending;
    assert.ok(!cancelled.success);
    assert.equal(cancelled.error.code, "REQUEST_CANCELLED");
    assert.equal(aborted, 2);
    assert.ok(events.every((event) => event.data.connected === false));
  } finally {
    clearTimeout(keepAlive);
  }
});
