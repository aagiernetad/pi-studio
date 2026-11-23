import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { DurableHost } from "../durable/host.js";
import { listProviderConfigs } from "../durable/provider-config.js";
import { RuntimeRequestDispatcher } from "./dispatcher.js";
import { registerProviderConfigHandlers } from "./provider-config.js";
import { registerProviderCredentialHandlers } from "./provider-credentials.js";
import { registerProviderTestHandlers } from "./provider-test.js";
import { RuntimeHandlerRegistry } from "./registry.js";

const config = { id: "custom-local", name: "Local test", baseUrl: "https://example.test/v1", modelId: "test-model", contextWindow: 32768, maxTokens: 4096 };
function client(host: DurableHost, credentials: InMemoryCredentialStore) {
  const registry = new RuntimeHandlerRegistry();
  registerProviderConfigHandlers(registry, host);
  registerProviderCredentialHandlers(registry, host.models, credentials);
  registerProviderTestHandlers(registry, host.models);
  const dispatcher = new RuntimeRequestDispatcher(registry);
  return (method: string, params: Record<string, unknown>, signal = new AbortController().signal) => {
    const id = randomUUID();
    return dispatcher.dispatch({ version: 1, kind: "request", id, method, params }, {
      requestId: id, receivedAt: Date.now(), signal, emit: () => {},
    });
  };
}

test("custom provider configuration restores into the shared Models and deletion preserves credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-studio-config-"));
  const credentials = new InMemoryCredentialStore();
  let host = await DurableHost.open(directory, credentials);
  try {
    let request = client(host, credentials);
    const shared = host.models;
    assert.ok((await request("provider.config.set", { ...config, baseUrl: config.baseUrl + "/" })).success);
    assert.equal(host.models, shared);
    assert.equal(host.models.getProvider(config.id)?.baseUrl, config.baseUrl);
    assert.equal(host.models.getModel(config.id, config.modelId)?.contextWindow, 32768);
    assert.ok((await request("provider.credential.set", { providerId: config.id, apiKey: "synthetic-config-key" })).success);
    await host.close();
    host = await DurableHost.open(directory, credentials);
    request = client(host, credentials);
    assert.ok(host.models.getModel(config.id, config.modelId));
    assert.ok(await host.models.checkAuth(config.id));
    assert.deepEqual(await listProviderConfigs(host.harness), [config]);
    assert.ok((await request("provider.config.delete", { providerId: config.id })).success);
    assert.equal(host.models.getProvider(config.id), undefined);
    assert.ok(await credentials.read(config.id));
    await host.close();
    host = await DurableHost.open(directory, credentials);
    assert.equal(host.models.getProvider(config.id), undefined);
    assert.deepEqual(await listProviderConfigs(host.harness), []);
    assert.ok(host.models.getProvider("deepseek"));
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});

test("custom configuration rejects unsafe endpoints, secret fields and built-in replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-studio-config-"));
  const host = await DurableHost.open(directory, new InMemoryCredentialStore());
  try {
    const request = client(host, new InMemoryCredentialStore());
    const original = host.models.getProvider("deepseek");
    for (const input of [
      { ...config, id: "deepseek" }, { ...config, apiKey: "synthetic-forbidden-secret" },
      { ...config, headers: { Authorization: "synthetic" } },
      { ...config, baseUrl: "https://user:password@example.test/v1" },
      { ...config, baseUrl: "https://example.test/v1?key=synthetic" },
      { ...config, baseUrl: "https://example.test/v1#fragment" },
      { ...config, baseUrl: "http://example.test/v1" },
      { ...config, baseUrl: "file:///tmp/model" },
      { ...config, maxTokens: 50000 }, { ...config, modelId: "model\nsecret" },
    ]) {
      const response = await request("provider.config.set", input);
      assert.ok(!response.success);
      assert.equal(response.error.code, "INVALID_PARAMS");
      assert.equal(JSON.stringify(response).includes("synthetic"), false);
    }
    assert.equal(host.models.getProvider("deepseek"), original);
    assert.deepEqual(await listProviderConfigs(host.harness), []);
    const deleted = await request("provider.config.delete", { providerId: "deepseek" });
    assert.ok(!deleted.success);
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});

test("configuration updates serialize, cancelled and failed commits do not replace the live provider", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-studio-config-"));
  const host = await DurableHost.open(directory, new InMemoryCredentialStore());
  try {
    const request = client(host, new InMemoryCredentialStore());
    const updates = await Promise.all([
      request("provider.config.set", config),
      request("provider.config.set", { ...config, modelId: "updated-model" }),
    ]);
    assert.ok(updates.every((value) => value.success));
    assert.equal(host.models.getModels(config.id)[0]?.id, "updated-model");
    assert.equal((await listProviderConfigs(host.harness))[0]?.modelId, "updated-model");
    const before = host.models.getProvider(config.id);
    const aborted = await request("provider.config.set", config, AbortSignal.abort());
    assert.ok(!aborted.success);
    const commit = context.mock.method(host.harness, "commit", async () => { throw new Error("synthetic-private-storage-error"); });
    const failed = await request("provider.config.set", config);
    assert.ok(!failed.success);
    assert.equal(failed.error.code, "PROVIDER_CONFIG_FAILED");
    assert.equal(JSON.stringify(failed).includes("synthetic-private"), false);
    assert.equal(host.models.getProvider(config.id), before);
    commit.mock.restore();
    assert.ok((await request("provider.config.set", config)).success, "Queue recovers after a failed write");
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});

test("custom provider reaches only the configured local endpoint using existing credentials and pi-ai", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-studio-config-"));
  const credentials = new InMemoryCredentialStore();
  const host = await DurableHost.open(directory, credentials);
  const calls: { url: string | undefined; authorized: boolean; body: Record<string, unknown> }[] = [];
  const server = createServer(async (incoming, outgoing) => {
    let raw = "";
    for await (const chunk of incoming) raw += chunk.toString();
    calls.push({ url: incoming.url, authorized: incoming.headers.authorization === "Bearer synthetic-local-key", body: JSON.parse(raw) });
    outgoing.writeHead(200, { "content-type": "text/event-stream" });
    for (const choice of [
      { index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null },
      { index: 0, delta: {}, finish_reason: "stop" },
    ]) outgoing.write(`data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 1, model: config.modelId, choices: [choice] })}\n\n`);
    outgoing.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const request = client(host, credentials);
    assert.ok((await request("provider.config.set", { ...config, baseUrl: `http://127.0.0.1:${address.port}/v1` })).success);
    assert.equal(calls.length, 0, "Saving configuration must not contact a model");
    assert.ok((await request("provider.credential.set", { providerId: config.id, apiKey: "synthetic-local-key" })).success);
    const response = await request("provider.test", { providerId: config.id, modelId: config.modelId });
    assert.ok(response.success);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "/v1/chat/completions");
    assert.ok(calls[0]?.authorized);
    assert.equal(calls[0]?.body.model, config.modelId);
    assert.equal(calls[0]?.body.max_tokens, 16);
    assert.equal(JSON.stringify(response).includes("synthetic"), false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await host.close();
    await rm(directory, { recursive: true, force: true });
  }
});
