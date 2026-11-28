import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { RuntimeRequestDispatcher } from "./dispatcher.js";
import { RuntimeHandlerRegistry } from "./registry.js";
import { registerWorkspaceHandlers, WORKSPACE_FILE_LIMIT } from "./workspace.js";

async function fixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "pi-studio-workspace-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "project");
  const outside = join(directory, "outside");
  await mkdir(root); await mkdir(outside);
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "docs", "guide.md"), "# 中文文档\n只读预览");
  await writeFile(join(root, "README.md"), "项目说明");
  await writeFile(join(outside, "secret.txt"), "outside-sensitive-marker");
  const registry = new RuntimeHandlerRegistry();
  registerWorkspaceHandlers(registry);
  const dispatcher = new RuntimeRequestDispatcher(registry);
  const events: unknown[] = [];
  function request(method: string, params: Record<string, unknown> = {}, signal = new AbortController().signal) {
    const id = randomUUID();
    return dispatcher.dispatch({ version: 1, kind: "request", id, method, params }, {
      requestId: id, receivedAt: Date.now(), signal, emit: (event, data) => { events.push({ event, data }); },
    });
  }
  async function choose(path = root) {
    const response = await request("workspace.open", { path });
    assert.ok(response.success);
    const workspace = response.result.workspace as { id: string; name: string };
    assert.ok(workspace.id);
    return workspace;
  }
  return { root, outside, directory, request, choose, events, registry };
}

test("workspace selection lists and previews UTF-8 without exposing the absolute root or writing files", async context => {
  const f = await fixture(context);
  const initial = await f.request("workspace.state");
  assert.ok(initial.success); assert.equal(initial.result.workspace, null);
  const workspace = await f.choose();
  assert.deepEqual(Object.keys(workspace).sort(), ["id", "name"]);
  assert.equal(workspace.name, "project");
  const list = await f.request("workspace.list", { workspaceId: workspace.id });
  assert.ok(list.success);
  assert.deepEqual(list.result.items, [
    { name: "docs", path: "docs", kind: "directory", previewable: false },
    { name: "README.md", path: "README.md", kind: "file", previewable: true },
  ]);
  const preview = await f.request("workspace.read", { workspaceId: workspace.id, path: "docs/guide.md" });
  assert.ok(preview.success);
  assert.equal(preview.result.text, "# 中文文档\n只读预览");
  assert.equal(preview.result.bytes, Buffer.byteLength("# 中文文档\n只读预览"));
  assert.equal(JSON.stringify([list, preview, f.events]).includes(f.root), false);
  assert.equal(await readFile(join(f.root, "docs", "guide.md"), "utf8"), "# 中文文档\n只读预览");
  const close = await f.request("workspace.close", { workspaceId: workspace.id });
  assert.ok(close.success);
  const stale = await f.request("workspace.read", { workspaceId: workspace.id, path: "README.md" });
  assert.ok(!stale.success); assert.equal(stale.error.code, "WORKSPACE_CHANGED");
});

test("workspace rejects traversal, foreign grants and strict parameter violations", async context => {
  const f = await fixture(context);
  const workspace = await f.choose();
  for (const path of ["../outside/secret.txt", "/outside/secret.txt", "docs/../../outside/secret.txt", "C:/secret.txt", "docs\\guide.md", "README.md:stream", "docs/.", "docs/..", "docs//guide.md", "docs/guide.md.", ".git/config", "bad\u0000.txt"]) {
    const denied = await f.request("workspace.list", { workspaceId: workspace.id, path });
    assert.ok(!denied.success, path);
    assert.equal(denied.error.code, "WORKSPACE_PATH_DENIED", path);
    assert.equal(JSON.stringify(denied).includes("outside-sensitive-marker"), false);
  }
  for (const [method, params] of [
    ["workspace.state", { path: f.root }], ["workspace.open", { path: f.root, extra: true }],
    ["workspace.list", { workspaceId: "invalid" }], ["workspace.read", { workspaceId: workspace.id, path: 3 }],
    ["workspace.close", { workspaceId: workspace.id, path: "README.md" }],
  ] satisfies [string, Record<string, unknown>][]) {
    const invalid = await f.request(method, params);
    assert.ok(!invalid.success); assert.equal(invalid.error.code, "INVALID_PARAMS");
  }
  const foreign = await f.request("workspace.list", { workspaceId: randomUUID() });
  assert.ok(!foreign.success); assert.equal(foreign.error.code, "WORKSPACE_CHANGED");
  const relative = await f.request("workspace.open", { path: "relative" });
  assert.ok(!relative.success); assert.equal(relative.error.code, "INVALID_PARAMS");
});

test("workspace blocks directory links and detects replacement of the selected directory", async context => {
  const f = await fixture(context);
  await symlink(f.outside, join(f.root, "escape"), process.platform === "win32" ? "junction" : "dir");
  const workspace = await f.choose();
  const list = await f.request("workspace.list", { workspaceId: workspace.id });
  assert.ok(list.success);
  assert.ok(Array.isArray(list.result.items));
  assert.ok(list.result.items.some(item => item.name === "escape" && item.kind === "blocked"));
  for (const method of ["workspace.list", "workspace.read"]) {
    const result = await f.request(method, { workspaceId: workspace.id, path: method === "workspace.read" ? "escape/secret.txt" : "escape" });
    assert.ok(!result.success); assert.equal(result.error.code, "WORKSPACE_PATH_DENIED");
  }
  await rename(f.root, join(f.directory, "old-project")); await mkdir(f.root);
  await writeFile(join(f.root, "README.md"), "replacement-marker");
  const replaced = await f.request("workspace.read", { workspaceId: workspace.id, path: "README.md" });
  assert.ok(!replaced.success); assert.equal(replaced.error.code, "WORKSPACE_PATH_DENIED");
});

test("workspace bounds reads and listings and rejects binary and unsupported content", async context => {
  const f = await fixture(context);
  await writeFile(join(f.root, "limit.txt"), "x".repeat(WORKSPACE_FILE_LIMIT));
  await writeFile(join(f.root, "large.txt"), "x".repeat(WORKSPACE_FILE_LIMIT + 1));
  await writeFile(join(f.root, "binary.txt"), Buffer.from([0, 1, 2]));
  await writeFile(join(f.root, "invalid.txt"), Buffer.from([0xff, 0xfe]));
  await writeFile(join(f.root, "app.exe"), "not executed");
  await writeFile(join(f.root, "empty.txt"), "");
  const workspace = await f.choose();
  const limit = await f.request("workspace.read", { workspaceId: workspace.id, path: "limit.txt" });
  assert.ok(limit.success); assert.equal(limit.result.bytes, WORKSPACE_FILE_LIMIT);
  assert.ok(Buffer.byteLength(JSON.stringify(limit)) < 512 * 1024);
  const large = await f.request("workspace.read", { workspaceId: workspace.id, path: "large.txt" });
  assert.ok(!large.success); assert.equal(large.error.code, "WORKSPACE_FILE_TOO_LARGE");
  for (const path of ["binary.txt", "invalid.txt", "app.exe", "docs"]) {
    const result = await f.request("workspace.read", { workspaceId: workspace.id, path });
    assert.ok(!result.success); assert.equal(result.error.code, "WORKSPACE_FILE_UNSUPPORTED");
  }
  const empty = await f.request("workspace.read", { workspaceId: workspace.id, path: "empty.txt" });
  assert.ok(empty.success); assert.equal(empty.result.text, "");
  await mkdir(join(f.root, "many"));
  await Promise.all(Array.from({ length: 205 }, (_, index) => writeFile(join(f.root, "many", `${index}.txt`), "test")));
  const many = await f.request("workspace.list", { workspaceId: workspace.id, path: "many" });
  assert.ok(many.success); assert.equal(many.result.truncated, true);
  assert.ok(Array.isArray(many.result.items)); assert.equal(many.result.items.length, 200);
});

test("workspace grants are process-local and old or cancelled requests cannot grant access", async context => {
  const f = await fixture(context);
  const first = await f.choose();
  const second = await f.choose(f.outside);
  assert.notEqual(first.id, second.id);
  for (const method of ["workspace.list", "workspace.read", "workspace.close"]) {
    const denied = await f.request(method, { workspaceId: first.id, ...(method === "workspace.read" ? { path: "README.md" } : {}) });
    assert.ok(!denied.success); assert.equal(denied.error.code, "WORKSPACE_CHANGED");
  }
  const controller = new AbortController(); controller.abort();
  const cancelled = await f.request("workspace.open", { path: f.root }, controller.signal);
  assert.ok(!cancelled.success); assert.equal(cancelled.error.code, "REQUEST_CANCELLED");
  const state = await f.request("workspace.state");
  assert.ok(state.success); assert.deepEqual(state.result.workspace, second);
  const opener = f.registry.resolve("workspace.open"); assert.ok(opener);
  const inFlight = new AbortController();
  const interrupted = Promise.resolve(opener({ version: 1, kind: "request", id: "open", method: "workspace.open", params: { path: f.root } }, {
    requestId: "open", receivedAt: Date.now(), signal: inFlight.signal, emit: () => {},
  }));
  inFlight.abort();
  await assert.rejects(interrupted, { name: "AbortError" });
  const afterCancelledOpen = await f.request("workspace.state");
  assert.ok(afterCancelledOpen.success); assert.deepEqual(afterCancelledOpen.result.workspace, second);
  const otherRegistry = new RuntimeHandlerRegistry(); registerWorkspaceHandlers(otherRegistry);
  const handler = otherRegistry.resolve("workspace.state"); assert.ok(handler);
  const result = await handler({ version: 1, kind: "request", id: "state", method: "workspace.state", params: {} }, {
    requestId: "state", receivedAt: Date.now(), signal: new AbortController().signal, emit: () => {},
  });
  assert.deepEqual(result, { workspace: null });
});
