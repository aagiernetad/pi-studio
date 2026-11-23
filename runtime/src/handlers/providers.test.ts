import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import {
  RuntimeResponseSchema,
  type RuntimeResponse,
} from "../protocol/messages.js";
import { RuntimeRequestDispatcher } from "./dispatcher.js";
import { registerProviderHandlers } from "./providers.js";
import { RuntimeHandlerRegistry } from "./registry.js";

function requester(models: Models) {
  const registry = new RuntimeHandlerRegistry();
  registerProviderHandlers(registry, models);
  const dispatcher = new RuntimeRequestDispatcher(registry);

  return (method: string, params: Record<string, unknown> = {}) => {
    const id = randomUUID();
    return dispatcher.dispatch({
      version: 1,
      kind: "request",
      id,
      method,
      params,
    }, {
      requestId: id,
      receivedAt: Date.now(),
      signal: new AbortController().signal,
      emit: () => {},
    });
  };
}

test("catalog handlers list built-ins without auth or remote operations", async (context) => {
  const models = builtinModels();
  for (const method of ["getAuth", "checkAuth", "getAvailable", "refresh", "stream", "streamSimple"] as const) {
    context.mock.method(models, method, () => {
      throw new Error("Catalog reads must not invoke auth or model operations");
    });
  }
  const request = requester(models);
  const providers = await request("provider.list");
  assert.ok(providers.success);
  assert.deepEqual(providers.result.items, models.getProviders()
    .map(({ id, name, auth }) => ({ id, name, supportsApiKey: Boolean(auth.apiKey?.login) }))
    .sort((a, b) => a.id.localeCompare(b.id)));

  for (const providerId of ["deepseek", "openai", "anthropic"]) {
    const response = await request("model.list", { providerId });
    assert.ok(response.success);
    const items = response.result.items;
    assert.ok(Array.isArray(items));
    assert.equal(items.length, models.getModels(providerId).length);
    assert.ok(items.length > 0);
    assert.ok(items.every((item) => item.provider === providerId));
    assert.deepEqual(items.map((item) => item.id),
      models.getModels(providerId).map((model) => model.id)
        .sort((a, b) => a.localeCompare(b)));
  }
});

test("catalog handlers read the live collection and expose only allowed fields", async () => {
  const models = createModels();
  const request = requester(models);
  const empty = await request("provider.list");
  assert.ok(empty.success);
  assert.deepEqual(empty.result, { items: [] });

  const provider = builtinModels().getProvider("deepseek");
  assert.ok(provider);
  const model = provider.getModels()[0];
  assert.ok(model);
  const sentinel = "synthetic-private-field-must-not-be-serialized";
  models.setProvider({
    ...provider,
    headers: { Authorization: sentinel },
    baseUrl: `https://example.invalid/${sentinel}`,
    getModels: () => [{
      ...model,
      headers: { Authorization: sentinel },
      baseUrl: `https://example.invalid/${sentinel}`,
    }],
  });

  const providers = await request("provider.list");
  assert.ok(providers.success);
  assert.deepEqual(providers.result, {
    items: [{ id: provider.id, name: provider.name, supportsApiKey: true }],
  });
  const response = await request("model.list", { providerId: provider.id });
  assert.ok(response.success);
  assert.deepEqual(response.result, { items: [{
    id: model.id,
    name: model.name,
    provider: model.provider,
    api: model.api,
    reasoning: model.reasoning,
    input: [...model.input],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    supportsConnectionTest: true,
  }] });
  assert.equal(JSON.stringify([providers, response]).includes(sentinel), false);

  // 已知 Provider 可以没有本地聊天目录；它与未知 Provider 不同。
  models.setProvider({ ...provider, getModels: () => [] });
  const noModels = await request("model.list", { providerId: provider.id });
  assert.ok(noModels.success);
  assert.deepEqual(noModels.result, { items: [] });

  models.deleteProvider(provider.id);
  const deleted = await request("model.list", { providerId: provider.id });
  assert.equal(deleted.success, false);
  if (!deleted.success) assert.equal(deleted.error.code, "PROVIDER_NOT_FOUND");
});

test("catalog handlers reject invalid parameters and unknown providers", async () => {
  const request = requester(createModels());
  for (const [method, params] of [
    ["provider.list", { unexpected: true }],
    ["provider.list", { apiKey: "synthetic-test-value" }],
    ["model.list", {}],
    ["model.list", { providerId: "" }],
    ["model.list", { providerId: "   " }],
    ["model.list", { providerId: 1 }],
    ["model.list", { providerId: null }],
    ["model.list", { providerId: "x".repeat(129) }],
    ["model.list", { providerId: "deepseek", unexpected: true }],
  ] satisfies [string, Record<string, unknown>][]) {
    const response = await request(method, params);
    assert.equal(response.success, false);
    if (!response.success) {
      assert.equal(response.error.code, "INVALID_PARAMS");
      assert.equal(response.error.details, undefined);
    }
  }
  const unknown = await request("model.list", { providerId: "unknown" });
  assert.equal(unknown.success, false);
  if (!unknown.success) assert.equal(unknown.error.code, "PROVIDER_NOT_FOUND");
});

test("catalog handlers respect the IPC response size budget", async () => {
  const provider = builtinModels().getProvider("deepseek");
  assert.ok(provider);
  const model = provider.getModels()[0];
  assert.ok(model);
  const oversized = "x".repeat(512 * 1024);
  const models = createModels();
  models.setProvider({
    ...provider,
    name: oversized,
    getModels: () => [{ ...model, name: oversized }],
  });
  const request = requester(models);
  for (const method of ["provider.list", "model.list"]) {
    const response = await request(method,
      method === "model.list" ? { providerId: provider.id } : {});
    assert.equal(response.success, false);
    if (!response.success) assert.equal(response.error.code, "RESPONSE_TOO_LARGE");
  }
});

test("Runtime entry serves catalogs over real JSONL IPC", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-studio-catalog-ipc-"));
  const child = spawn(process.execPath, [
    "--import", "tsx",
    fileURLToPath(new URL("../index.ts", import.meta.url)),
  ], {
    env: { ...process.env, PI_STUDIO_DATA_DIR: directory },
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  const closed = once(child, "close");

  try {
    const requests = [
      { id: "providers", method: "provider.list", params: {} },
      { id: "models", method: "model.list", params: { providerId: "deepseek" } },
      { id: "ping", method: "runtime.ping", params: { message: "catalog-check" } },
      { id: "test-params", method: "provider.test", params: {} },
      { id: "configs", method: "provider.config.list", params: {} },
      { id: "config-params", method: "provider.config.set", params: {} },
    ];
    child.stdin.end(requests.map((request) => JSON.stringify({
      version: 1, kind: "request", ...request,
    }) + "\n").join(""));

    const responses = new Map<string, RuntimeResponse>();
    for await (const line of createInterface({ input: child.stdout })) {
      const response = RuntimeResponseSchema.parse(JSON.parse(line));
      responses.set(response.id, response);
    }
    const [code] = await closed;
    assert.equal(code, 0);
    assert.equal(responses.size, 6);
    const providers = responses.get("providers");
    assert.ok(providers?.success);
    assert.ok(Array.isArray(providers.result.items));
    assert.ok(providers.result.items.some((provider) => provider.id === "deepseek"));
    const models = responses.get("models");
    assert.ok(models?.success);
    assert.ok(Array.isArray(models.result.items));
    assert.ok(models.result.items.length > 0);
    const ping = responses.get("ping");
    assert.ok(ping?.success);
    assert.equal(ping.result.message, "catalog-check");
    const invalidTest = responses.get("test-params");
    assert.ok(invalidTest && !invalidTest.success);
    assert.equal(invalidTest.error.code, "INVALID_PARAMS");
    const configs = responses.get("configs");
    assert.ok(configs?.success);
    assert.deepEqual(configs.result.items, []);
    const invalidConfig = responses.get("config-params");
    assert.ok(invalidConfig && !invalidConfig.success);
    assert.equal(invalidConfig.error.code, "INVALID_PARAMS");
  } finally {
    if (child.exitCode === null) child.kill();
    await closed;
    await rm(directory, { recursive: true, force: true });
  }
});
