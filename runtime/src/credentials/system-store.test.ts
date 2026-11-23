import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { SystemCredentialStore, createSystemCredentialStore } from "./system-store.js";
import { memoryBackend } from "./fixtures/memory-backend.js";

test("credential store preserves pi-ai read/modify/list/delete semantics", async () => {
  const { backend } = memoryBackend();
  const store = new SystemCredentialStore(backend);
  assert.equal(await store.read("deepseek"), undefined);
  assert.deepEqual(await store.list(), []);
  await store.modify("deepseek", async () => ({ type: "api_key", key: "synthetic-key", env: { REGION: "test" } }));
  const first = await store.read("deepseek");
  assert.deepEqual(await store.modify("deepseek", async () => undefined), first);
  assert.deepEqual(await store.list(), [{ providerId: "deepseek", type: "api_key" }]);
  await store.modify("oauth-test", async () => ({
    type: "oauth", refresh: "synthetic-refresh", access: "synthetic-access", expires: 123,
    accountId: "synthetic-account",
  }));
  const oauth = await store.read("oauth-test");
  assert.ok(oauth?.type === "oauth" && oauth.accountId === "synthetic-account");
  assert.equal(JSON.stringify(await store.list()).includes("synthetic"), false);
  await store.delete("deepseek");
  await store.delete("deepseek");
  assert.equal(await store.read("deepseek"), undefined);
});

test("credential writes and deletion serialize per provider and recover after rejection", async () => {
  const { backend } = memoryBackend();
  const store = new SystemCredentialStore(backend);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const first = store.modify("deepseek", async () => {
    started();
    await gate;
    return { type: "api_key", key: "first" };
  });
  await entered;
  const second = store.modify("deepseek", async (current) => {
    assert.ok(current?.type === "api_key" && current.key === "first");
    return { type: "api_key", key: "second" };
  });
  const deletion = store.delete("deepseek");
  // 不同 Provider 的操作不应被这一队列阻塞。
  await store.modify("openai", async () => ({ type: "api_key", key: "other" }));
  release();
  await Promise.all([first, second, deletion]);
  assert.equal(await store.read("deepseek"), undefined);
  await assert.rejects(store.modify("deepseek", async () => { throw new Error("callback failure"); }));
  await store.modify("deepseek", async () => ({ type: "api_key", key: "recovered" }));
  assert.ok(await store.read("deepseek"));
});

test("aborted credential operations do not write and native work retains the queue", async () => {
  const { backend, values } = memoryBackend();
  const store = new SystemCredentialStore(backend);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(store.modify("deepseek", async () => ({ type: "api_key", key: "no-write" }), { signal: aborted.signal }));
  assert.equal(values.size, 0);
  const duringCallback = new AbortController();
  await assert.rejects(store.modify("deepseek", async () => {
    duringCallback.abort();
    return { type: "api_key", key: "no-write" };
  }, { signal: duringCallback.signal }));
  assert.equal(values.size, 0);

  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const originalWrite = backend.write;
  backend.write = async (id, value) => { started(); await gate; await originalWrite(id, value); };
  const inNative = new AbortController();
  const first = store.modify("deepseek", async () => ({ type: "api_key", key: "first" }), { signal: inNative.signal });
  await entered;
  inNative.abort();
  let secondRan = false;
  const second = store.modify("deepseek", async (current) => {
    secondRan = true;
    assert.ok(current?.type === "api_key" && current.key === "first");
    return undefined;
  });
  await Promise.resolve();
  assert.equal(secondRan, false);
  release();
  await Promise.all([first, second]);
});

test("credential storage failures and malformed data never expose their payload", async () => {
  const { backend, values } = memoryBackend();
  const store = new SystemCredentialStore(backend);
  const marker = "synthetic-private-error-content";
  const safeError = (error: unknown) => error instanceof Error && !String(error).includes(marker) && error.cause === undefined;
  values.set("deepseek", marker);
  await assert.rejects(store.read("deepseek"), safeError);
  await assert.rejects(store.list(), safeError);
  const originalRead = backend.read;
  backend.read = async () => { throw new Error(marker); };
  await assert.rejects(store.read("deepseek"), safeError);
  backend.read = originalRead;
  values.clear();
  await assert.rejects(store.modify("deepseek", async () => ({ type: "api_key", key: "x".repeat(2000) })));
  assert.equal(values.size, 0);
  backend.write = async () => { throw new Error(marker); };
  await assert.rejects(store.modify("deepseek", async () => ({ type: "api_key", key: marker })), safeError);
  backend.delete = async () => { throw new Error(marker); };
  await assert.rejects(store.delete("deepseek"), safeError);
});

test("Windows credentials survive a separate Node process and delete cleanly", {
  skip: process.platform !== "win32", timeout: 20_000,
}, async () => {
  const service = `com.pistudio.app.test.${randomUUID()}`;
  const store = createSystemCredentialStore(service);
  const key = `synthetic-${randomUUID()}`;
  try {
    assert.equal(await store.read("deepseek"), undefined);
    await store.modify("deepseek", async () => ({ type: "api_key", key }));
    const child = spawn(process.execPath, [
      "--import", "tsx", fileURLToPath(new URL("./fixtures/read-system-store.ts", import.meta.url)),
    ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const closed = once(child, "close");
    let output = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.stdin.end(JSON.stringify({ service, providerId: "deepseek", key }));
    try {
      const [code] = await closed;
      assert.equal(code, 0);
      assert.equal(output.includes(key) || stderr.includes(key), false);
      assert.deepEqual(JSON.parse(output), { restored: true, resolved: true, listed: true });
    } finally {
      if (child.exitCode === null) child.kill();
      await closed;
    }
    await createSystemCredentialStore(service).delete("deepseek");
    assert.equal(await store.read("deepseek"), undefined);
    assert.deepEqual(await store.list(), []);
  } finally {
    await store.delete("deepseek");
  }
});
