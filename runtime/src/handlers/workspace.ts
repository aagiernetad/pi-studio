import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { RuntimeApplicationError } from "../protocol/errors.js";
import type { RuntimeHandlerRegistry } from "./registry.js";

export const WORKSPACE_FILE_LIMIT = 64 * 1024;
const ENTRY_LIMIT = 200;
const textExtensions = new Set([".txt", ".md", ".json", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".html", ".rs", ".toml", ".yaml", ".yml", ".py", ".sql", ".csv", ".xml", ".svg", ".sh"]);
const textNames = new Set(["Dockerfile", "Makefile", "LICENSE", ".gitignore"]);
const previewable = (name: string) => textExtensions.has(extname(name).toLowerCase()) || textNames.has(name);
const Empty = z.object({}).strict();
const Selected = z.object({ workspaceId: z.uuid() }).strict();
const Location = Selected.extend({ path: z.string().max(1024).default("") });
const Open = z.object({ path: z.string().min(1).max(4096) }).strict();
type Workspace = { id: string; root: string; identity: BigIntStats };
function fail(code: string): never { throw new RuntimeApplicationError(code, "Workspace operation could not be completed."); }
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) fail("INVALID_PARAMS");
  return result.data;
}
function parts(path: string): string[] {
  if (!path) return [];
  const values = path.split("/");
  if (/[\\:\x00-\x1f]/.test(path) || values.some(value => !value || value === "." || value === ".." || value.toLowerCase() === ".git" || /[. ]$/.test(value))) fail("WORKSPACE_PATH_DENIED");
  return values;
}
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;

/** One explicit, process-local directory grant. Node alone resolves paths and reads files. */
export function registerWorkspaceHandlers(registry: RuntimeHandlerRegistry): void {
  let selected: Workspace | null = null;
  let selection = 0;
  const publicWorkspace = () => selected ? { id: selected.id, name: basename(selected.root) || selected.root } : null;
  function current(id: string, signal: AbortSignal): Workspace {
    signal.throwIfAborted();
    if (!selected || selected.id !== id) fail("WORKSPACE_CHANGED");
    return selected;
  }
  async function checkRoot(workspace: Workspace, signal: AbortSignal) {
    current(workspace.id, signal);
    const info = await lstat(workspace.root, { bigint: true });
    if (info.isSymbolicLink() || !info.isDirectory() || !same(info, workspace.identity)) fail("WORKSPACE_PATH_DENIED");
    current(workspace.id, signal);
  }
  async function resolve(workspace: Workspace, path: string, signal: AbortSignal) {
    const segments = parts(path);
    await checkRoot(workspace, signal);
    let target = workspace.root;
    let info = workspace.identity;
    for (const segment of segments) {
      target = join(target, segment);
      info = await lstat(target, { bigint: true });
      if (info.isSymbolicLink()) fail("WORKSPACE_PATH_DENIED");
      current(workspace.id, signal);
    }
    const canonical = await realpath(target);
    const distance = relative(workspace.root, canonical);
    if (isAbsolute(distance) || distance === ".." || distance.startsWith(".." + sep)) fail("WORKSPACE_PATH_DENIED");
    return { target, info };
  }

  registry.register("workspace.state", request => {
    parse(Empty, request.params);
    return { workspace: publicWorkspace() };
  });
  // Called by the trusted Rust folder picker, never by a renderer-supplied absolute path.
  registry.register("workspace.open", async (request, context) => {
    const { path } = parse(Open, request.params);
    const revision = ++selection;
    if (!isAbsolute(path)) fail("INVALID_PARAMS");
    const root = await realpath(path);
    const identity = await stat(root, { bigint: true });
    if (!identity.isDirectory()) fail("WORKSPACE_NOT_DIRECTORY");
    context.signal.throwIfAborted();
    if (revision !== selection) fail("WORKSPACE_CHANGED");
    selected = { id: randomUUID(), root, identity };
    context.emit("workspace.changed", { workspaceId: selected.id });
    return { workspace: publicWorkspace() };
  });
  registry.register("workspace.close", (request, context) => {
    const { workspaceId } = parse(Selected, request.params);
    current(workspaceId, context.signal);
    selected = null;
    selection++;
    context.emit("workspace.changed", { workspaceId: null });
    return { closed: true };
  });
  registry.register("workspace.list", async (request, context) => {
    const { workspaceId, path } = parse(Location, request.params);
    const workspace = current(workspaceId, context.signal);
    const { target, info } = await resolve(workspace, path, context.signal);
    if (!info.isDirectory()) fail("WORKSPACE_NOT_DIRECTORY");
    const items: { name: string; path: string; kind: "directory" | "file" | "blocked"; previewable: boolean }[] = [];
    let truncated = false;
    let bytes = 0;
    const directory = await opendir(target);
    for await (const entry of directory) {
      current(workspaceId, context.signal);
      const childPath = path ? path + "/" + entry.name : entry.name;
      const blocked = entry.isSymbolicLink() || entry.name.toLowerCase() === ".git" || childPath.length > 1024;
      const item = { name: entry.name, path: childPath, kind: blocked ? "blocked" as const : entry.isDirectory() ? "directory" as const : entry.isFile() ? "file" as const : "blocked" as const,
        previewable: !blocked && entry.isFile() && previewable(entry.name) };
      bytes += Buffer.byteLength(JSON.stringify(item), "utf8");
      if (items.length === ENTRY_LIMIT || bytes > 128 * 1024) { truncated = true; break; }
      items.push(item);
    }
    await resolve(workspace, path, context.signal);
    items.sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name, "zh-CN"));
    return { workspaceId, path, items, truncated };
  });
  registry.register("workspace.read", async (request, context) => {
    const { workspaceId, path } = parse(Location, request.params);
    const workspace = current(workspaceId, context.signal);
    if (!path || !previewable(basename(path))) fail("WORKSPACE_FILE_UNSUPPORTED");
    const { target, info } = await resolve(workspace, path, context.signal);
    if (!info.isFile()) fail("WORKSPACE_FILE_UNSUPPORTED");
    if (info.size > BigInt(WORKSPACE_FILE_LIMIT)) fail("WORKSPACE_FILE_TOO_LARGE");
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = await handle.stat({ bigint: true });
      const checked = await resolve(workspace, path, context.signal);
      if (!opened.isFile() || !same(opened, info) || !same(opened, checked.info)) fail("WORKSPACE_PATH_DENIED");
      const buffer = Buffer.alloc(WORKSPACE_FILE_LIMIT + 1);
      let length = 0;
      while (length < buffer.length) {
        current(workspaceId, context.signal);
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > WORKSPACE_FILE_LIMIT) fail("WORKSPACE_FILE_TOO_LARGE");
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)); }
      catch { fail("WORKSPACE_FILE_UNSUPPORTED"); }
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) fail("WORKSPACE_FILE_UNSUPPORTED");
      const final = await resolve(workspace, path, context.signal);
      const after = await handle.stat({ bigint: true });
      if (!same(opened, final.info) || opened.size !== after.size || opened.mtimeNs !== after.mtimeNs) fail("WORKSPACE_FILE_CHANGED");
      return { workspaceId, path, name: basename(path), bytes: length, text };
    } finally { await handle.close(); }
  });
}
