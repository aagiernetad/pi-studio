import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Readable, Writable } from "node:stream";

import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import { memoryBackend } from "../credentials/fixtures/memory-backend.js";
import { SystemCredentialStore } from "../credentials/system-store.js";
import { DurableHost } from "../durable/host.js";
import { RuntimeRequestDispatcher } from "./dispatcher.js";
import { registerProviderCredentialHandlers } from "./provider-credentials.js";
import { RuntimeHandlerRegistry } from "./registry.js";
import { JsonlServer } from "../server/jsonl-server.js";
import { RuntimeResponseSchema, RuntimeEventSchema } from "../protocol/messages.js";

function setup() {
  const { backend, values } = memoryBackend();
  const credentials = new SystemCredentialStore(backend);
  const models = builtinModels({
    credentials,
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  const registry = new RuntimeHandlerRegistry();
  registerProviderCredentialHandlers(registry, models, credentials);
  const dispatcher = new RuntimeRequestDispatcher(registry);
  const events: { event: string; data: Record<string, unknown> }[] = [];
  async function request(method: string, params: Record<string, unknown>) {
    const id = randomUUID();
    return dispatcher.dispatch({ version: 1, kind: "request", id, method: `provider.credential.${method}`, params }, {
      requestId: id, receivedAt: Date.now(), signal: new AbortController().signal,
      emit: (event, data) => { events.push({ event, data }); },
    });
  }
  return { request, models, credentials, backend, values, events };
}

test("API key save/status/delete share model credentials and return only metadata", async () => {
  const { request, models, credentials, events } = setup();
  const key = "synthetic-api-key-for-test";
  const empty = await request("status", { providerId: "deepseek" });
  assert.ok(empty.success);
  assert.deepEqual(empty.result, { providerId: "deepseek", stored: false, type: null });
  await credentials.modify("deepseek", async () => ({ type: "api_key", env: { REGION: "test" } }));
  const saved = await request("set", { providerId: "deepseek", apiKey: key });
  assert.ok(saved.success);
  assert.deepEqual(saved.result, { providerId: "deepseek", stored: true, type: "api_key" });
  assert.equal((await credentials.read("deepseek"))?.type, "api_key");
  assert.ok((await models.getAuth("deepseek"))?.auth.apiKey === key);
  const retained = await credentials.read("deepseek");
  assert.ok(retained?.type === "api_key" && retained.env?.REGION === "test");
  const status = await request("status", { providerId: "deepseek" });
  assert.ok(status.success);
  assert.deepEqual(status.result, saved.result);
  const deleted = await request("delete", { providerId: "deepseek" });
  assert.ok(deleted.success);
  assert.equal(await models.getAuth("deepseek"), undefined);
  assert.ok((await request("delete", { providerId: "deepseek" })).success);
  assert.equal(JSON.stringify([empty, saved, status, deleted, events]).includes(key), false);
  assert.deepEqual(events[0], {
    event: "provider.credential.changed", data: { providerId: "deepseek", stored: true },
  });
  assert.deepEqual(events[1], {
    event: "provider.credential.changed", data: { providerId: "deepseek", stored: false },
  });
});

test("credential handlers reject invalid inputs and providers without writing", async () => {
  const { request, models, values, events } = setup();
  for (const [method, params] of [
    ["set", { providerId: "deepseek" }],
    ["set", { providerId: "deepseek", apiKey: "" }],
    ["set", { providerId: "deepseek", apiKey: "   " }],
    ["set", { providerId: "deepseek", apiKey: "a\nb" }],
    ["set", { providerId: "deepseek", apiKey: "a\0b" }],
    ["set", { providerId: "deepseek", apiKey: "x".repeat(1025) }],
    ["set", { providerId: "deepseek", apiKey: 123 }],
    ["set", { providerId: "deepseek", apiKey: "synthetic", unexpected: true }],
    ["status", { providerId: "deepseek", apiKey: "synthetic" }],
    ["delete", {}],
  ] satisfies [string, Record<string, unknown>][]) {
    const response = await request(method, params);
    assert.equal(response.success, false);
    if (!response.success) assert.equal(response.error.code, "INVALID_PARAMS");
  }
  for (const method of ["set", "status", "delete"]) {
    const response = await request(method, { providerId: "unknown", ...(method === "set" ? { apiKey: "synthetic" } : {}) });
    assert.equal(response.success, false);
    if (!response.success) assert.equal(response.error.code, "PROVIDER_NOT_FOUND");
  }
  const provider = models.getProvider("deepseek");
  assert.ok(provider);
  models.setProvider({ ...provider, auth: { apiKey: { name: "ambient", resolve: async () => undefined } } });
  const unsupported = await request("set", { providerId: "deepseek", apiKey: "synthetic" });
  assert.equal(unsupported.success, false);
  if (!unsupported.success) assert.equal(unsupported.error.code, "PROVIDER_API_KEY_UNSUPPORTED");
  assert.equal(values.size, 0);
  assert.deepEqual(events, []);
});

test("credential handlers hide storage failures without reporting success or emitting events", async () => {
  const { request, backend, values, events } = setup();
  const marker = "synthetic-secret-in-native-error";
  backend.read = async () => { throw new Error(marker); };
  backend.delete = async () => { throw new Error(marker); };
  for (const method of ["set", "status", "delete"]) {
    const response = await request(method, { providerId: "deepseek", ...(method === "set" ? { apiKey: marker } : {}) });
    assert.equal(response.success, false);
    if (!response.success) {
      assert.equal(response.error.code, "CREDENTIAL_STORE_UNAVAILABLE");
      assert.equal(response.error.details, undefined);
    }
    assert.equal(JSON.stringify(response).includes(marker), false);
  }
  assert.equal(values.size, 0);
  assert.deepEqual(events, []);
});

test("DurableHost Models resolve credentials from the injected store", async () => {
  const { backend } = memoryBackend();
  const credentials = new SystemCredentialStore(backend);
  const directory = await mkdtemp(join(tmpdir(), "pi-studio-credential-host-"));
  let host: DurableHost | undefined;
  try {
    host = await DurableHost.open(directory, credentials);
    await credentials.modify("deepseek", async () => ({ type: "api_key", key: "synthetic-host-key" }));
    assert.ok((await host.models.getAuth("deepseek"))?.auth.apiKey === "synthetic-host-key");
    assert.ok((await host.root()).id);
  } finally {
    await host?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("credential JSONL responses, events and logs never echo the submitted key", async () => {
  const { backend } = memoryBackend();
  const credentials = new SystemCredentialStore(backend);
  const models = builtinModels({ credentials });
  const registry = new RuntimeHandlerRegistry();
  registerProviderCredentialHandlers(registry, models, credentials);
  const marker = "synthetic-jsonl-private-key";
  const output: string[] = [];
  const logs: string[] = [];
  const server = new JsonlServer(new RuntimeRequestDispatcher(registry), {
    input: Readable.from([JSON.stringify({
      version: 1, kind: "request", id: "save-key",
      method: "provider.credential.set", params: { providerId: "deepseek", apiKey: marker },
    }) + "\n"]),
    output: new Writable({
      write(chunk, _encoding, callback) { output.push(chunk.toString()); callback(); },
    }),
    log: (message) => { logs.push(message); },
  });
  await server.run();
  assert.equal(output.join("").includes(marker), false);
  assert.equal(logs.join("\n").includes(marker), false);
  const messages: unknown[] = output.join("").trim().split("\n").map((line) => JSON.parse(line));
  const response = messages.map((message) => RuntimeResponseSchema.safeParse(message))
    .find((parsed) => parsed.success);
  assert.ok(response?.success && response.data.success);
  assert.deepEqual(response.data.result, { providerId: "deepseek", stored: true, type: "api_key" });
  const event = messages.map((message) => RuntimeEventSchema.safeParse(message))
    .find((parsed) => parsed.success);
  assert.ok(event?.success);
  assert.deepEqual(event.data.data, { providerId: "deepseek", stored: true, requestId: "save-key" });
});
