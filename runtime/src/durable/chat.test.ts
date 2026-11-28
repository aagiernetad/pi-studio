import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { AgentDoc, LiveDoc, UsageDoc, type ConversationId, type SubmissionId } from "@earendil-works/pi-durable";
import { DurableHost } from "./host.js";
import { createUserConversation } from "./conversations.js";
import { registerChatHandlers } from "./chat-handlers.js";
import { registerConversationHandlers } from "./conversation-handlers.js";
import { configuredProvider, writeProviderConfig } from "./provider-config.js";
import { RuntimeHandlerRegistry } from "../handlers/registry.js";
import { RuntimeRequestDispatcher } from "../handlers/dispatcher.js";

async function fixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "pi-studio-chat-"));
  const credentials = new InMemoryCredentialStore();
  let mode: "success" | "error" | "slow" = "success";
  let reportUsage = false;
  let thinking: string | null = null;
  let script: string | null = null;
  let repeatScript = false;
  let scriptTool: "codemode" | "python" = "codemode";
  let finishThinking = () => {};
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
    if (script !== null && (JSON.stringify(body.tools) ?? "").includes('"' + scriptTool + '"')) {
      const code = script;
      if (!repeatScript) script = null;
      response.write(`data: ${JSON.stringify({ id: "chat-local", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [
        { index: 0, id: "sandbox-call-" + calls.length, type: "function", function: { name: scriptTool, arguments: JSON.stringify({ code }) } },
      ] }, finish_reason: "tool_calls" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
      return;
    }
    const write = (content: string, reason: string | null) => response.write(`data: ${JSON.stringify({ id: "chat-local", object: "chat.completion.chunk", created: 1, model: "chat-model", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: reason }] })}\n\n`);
    if (thinking !== null) {
      response.write(`data: ${JSON.stringify({ id: "chat-local", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: thinking }, finish_reason: null }] })}\n\n`);
      if (mode === "slow") {
        finishThinking = () => { write("思考后的回复", "stop"); response.end("data: [DONE]\n\n"); };
        return;
      }
    }
    write("本地回复", null);
    if (reportUsage) response.write(`data: ${JSON.stringify({ id: "chat-local", choices: [], usage: {
      prompt_tokens: 12, completion_tokens: 5, total_tokens: 17,
      prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 3 },
    } })}\n\n`);
    if (mode !== "slow") {
      write("完成", "stop");
      response.end("data: [DONE]\n\n");
    }
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
    registerConversationHandlers(registry, host);
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
    get host() { return host; }, directory, credentials, conversation, config, calls, request, settled,
    setMode(next: typeof mode) { mode = next; },
    enableUsage() { reportUsage = true; },
    disableUsage() { reportUsage = false; },
    enableThinking(text: string) { thinking = text; },
    finishThinking() { finishThinking(); },
    setScript(code: string, repeat = false, tool: "codemode" | "python" = "codemode") { script = code; repeatScript = repeat; scriptTool = tool; },
    input(content = "你好") { return { conversationId: conversation.id, requestId: randomUUID(), providerId: config.id, modelId: config.modelId, content }; },
    async reopen() { await host.close(); host = await DurableHost.open(directory, credentials); },
  };
}

test("opt-in native sandbox isolates host capabilities, VM globals and conversation stores, and persists tool results", { timeout: 30_000 }, async context => {
  const f = await fixture(context);
  const input = { ...f.input("计算并检查隔离"), sandbox: true };
  f.setScript(`store("private", "conversation-one"); globalThis.privateValue = 7;
    let imported = false;
    try { await import("node:fs"); imported = true; } catch {}
    return { answer: 6 * 7, process: typeof process, require: typeof require, fetch: typeof fetch,
      wasm: typeof WebAssembly, tools: ALL_TOOLS.length, models: typeof models, imported,
      constructorEscape: ({}).constructor.constructor("return typeof process")() };`);
  const submitted = await f.request("conversation.chat.submit", input);
  assert.ok(submitted.success);
  assert.equal((await f.settled(submitted.result.submissionId)).status, "done");
  const toolResult = JSON.stringify(f.calls[1]?.messages);
  assert.match(toolResult, /answer.*42/);
  for (const name of ["process", "require", "fetch", "wasm", "models"]) assert.match(toolResult, new RegExp(name + '.*undefined'));
  assert.match(toolResult, /tools.*0/);
  assert.match(toolResult, /imported.*false/);
  assert.match(toolResult, /constructorEscape.*undefined/);
  assert.equal(f.calls.length, 2, "Durable runs the tool and asks the model for the final answer");
  assert.equal(JSON.stringify(f.calls[0]?.tools).includes('"codemode"'), true);
  assert.equal(JSON.stringify(f.calls[0]).includes("synthetic-chat-secret"), false);
  const conflict = await f.request("conversation.chat.submit", { ...input, sandbox: false });
  assert.ok(!conflict.success && conflict.error.code === "REQUEST_ID_CONFLICT");
  await f.reopen();
  const status = await f.request("conversation.chat.status", { conversationId: f.conversation.id });
  assert.ok(status.success && status.result.sandbox === true);
  const duplicate = await f.request("conversation.chat.submit", input);
  assert.ok(duplicate.success && duplicate.result.submissionId === submitted.result.submissionId);
  assert.equal(f.calls.length, 2);
  const history = await f.request("conversation.entries", { conversationId: f.conversation.id, limit: 20 });
  assert.ok(history.success);
  assert.match(JSON.stringify(history.result), /pi.tool-result/);
  assert.match(JSON.stringify(history.result), /answer.*42/);

  const other = await createUserConversation(f.host.harness, randomUUID(), "隔离会话");
  f.setScript('return { stored: load("private") ?? null, global: typeof privateValue };');
  const separate = await f.request("conversation.chat.submit", { ...f.input(), conversationId: other.id, sandbox: true });
  assert.ok(separate.success);
  assert.equal((await f.settled(separate.result.submissionId)).status, "done");
  assert.match(JSON.stringify(f.calls.at(-1)?.messages), /stored.*null.*global.*undefined/);
  f.setScript('return { stored: load("private"), global: typeof privateValue };');
  const again = await f.request("conversation.chat.submit", { ...f.input(), sandbox: true });
  assert.ok(again.success);
  assert.equal((await f.settled(again.result.submissionId)).status, "done");
  assert.match(JSON.stringify(f.calls.at(-1)?.messages), /stored.*conversation-one.*global.*undefined/);
  const plain = await f.request("conversation.chat.submit", f.input("普通聊天"));
  assert.ok(plain.success);
  assert.equal((await f.settled(plain.result.submissionId)).status, "done");
  assert.deepEqual(f.calls.at(-1)?.tools ?? [], [], "turning off the sandbox removes all model tools");
});

test("sandbox clamps model-requested deadlines and output, contains memory exhaustion, and remains usable", { timeout: 30_000 }, async context => {
  const f = await fixture(context);
  async function run(code: string) {
    f.setScript(code);
    const submitted = await f.request("conversation.chat.submit", { ...f.input(), sandbox: true });
    assert.ok(submitted.success);
    assert.equal((await f.settled(submitted.result.submissionId)).status, "done");
    const messages = f.calls.at(-1)?.messages as { role: string; content: string }[];
    const result = [...messages].reverse().find(message => message.role === "tool");
    assert.ok(result);
    return result.content;
  }
  const started = Date.now();
  assert.match(await run('// @options: {"timeout_ms": 600000}\nwhile (true) {}'), /timed out|timeout/i);
  assert.ok(Date.now() - started < 15_000, "model options cannot remove the host deadline");
  assert.match(await run('const values = []; while (true) values.push("x".repeat(1024 * 1024));'), /memory/i);
  const output = await run('// @options: {"max_output_tokens": 100000}\ntext("x".repeat(100000));');
  assert.ok(Buffer.byteLength(output) <= 16 * 1024);
  f.setScript("while (true) {}");
  const running = await f.request("conversation.chat.submit", { ...f.input(), sandbox: true });
  assert.ok(running.success);
  const deadline = Date.now() + 5000;
  while (true) {
    const status = await f.request("conversation.chat.status", { conversationId: f.conversation.id });
    assert.ok(status.success);
    if (status.result.phase === "computing") break;
    assert.ok(Date.now() < deadline, "sandbox enters the native tool task");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const stopped = await f.request("conversation.chat.abort", { conversationId: f.conversation.id });
  assert.ok(stopped.success);
  assert.equal((await f.settled(running.result.submissionId)).status, "unanswered");
  assert.match(await run("return 21 * 2;"), /42/);
  const before = f.calls.length;
  f.setScript("return 1;", true);
  const looping = await f.request("conversation.chat.submit", { ...f.input(), sandbox: true });
  assert.ok(looping.success);
  assert.equal((await f.settled(looping.result.submissionId)).status, "unanswered");
  const limited = await f.request("conversation.chat.status", { conversationId: f.conversation.id });
  assert.ok(limited.success && limited.result.failureReason === "turn_limit");
  assert.equal(f.calls.length - before, 3, "Durable bounds repeated tool rounds without a second scheduler");
});

test("Python sandbox runs standard-library calculations without host files, environment, network or processes", { timeout: 30_000 }, async context => {
  const f = await fixture(context);
  const hostFile = join(f.directory, "host-only.txt");
  await writeFile(hostFile, "synthetic-host-only");
  const previous = process.env.PI_STUDIO_PYTHON_SENTINEL;
  process.env.PI_STUDIO_PYTHON_SENTINEL = "synthetic-private-environment";
  context.after(() => { if (previous === undefined) delete process.env.PI_STUDIO_PYTHON_SENTINEL; else process.env.PI_STUDIO_PYTHON_SENTINEL = previous; });
  const input = { ...f.input("用 Python 计算"), sandbox: true };
  f.setScript(`import json, math, statistics, csv, io, os, sys
private_value = 7
def denied(code):
    try:
        exec(code)
        return False
    except Exception:
        return True
print(json.dumps({
    "answer": math.factorial(5), "mean": statistics.mean([2, 4, 6]),
    "csv": list(csv.reader(io.StringIO("a,b\\n1,2")))[1],
    "environment": os.getenv("PI_STUDIO_PYTHON_SENTINEL"),
    "read_denied": denied("open(" + repr(${JSON.stringify(hostFile)}) + ").read()"),
    "write_denied": denied("open('scratch.txt', 'w').write('blocked')"),
    "network_denied": denied("import socket; socket.socket()"),
    "process_denied": denied("import subprocess; subprocess.run([sys.executable, '-c', 'pass'])"),
    "bridge_denied": denied("import js"), "unicode": "你好，Python"
}, ensure_ascii=False))`, false, "python");
  const submitted = await f.request("conversation.chat.submit", input);
  assert.ok(submitted.success);
  assert.equal((await f.settled(submitted.result.submissionId)).status, "done");
  const messages = f.calls[1]?.messages as { role: string; content: string }[];
  const output = messages.find(message => message.role === "tool")?.content ?? "";
  assert.match(output, /"answer": 120/);
  assert.match(output, /"mean": 4/);
  assert.match(output, /"csv": \["1", "2"\]/);
  assert.match(output, /"environment": null/);
  for (const name of ["read", "write", "network", "process", "bridge"]) assert.match(output, new RegExp('"' + name + '_denied": true'));
  assert.match(output, /你好，Python/);
  assert.equal(JSON.stringify(f.calls).includes("synthetic-private-environment"), false);
  assert.equal(JSON.stringify(f.calls).includes("synthetic-host-only"), false);
  assert.equal(f.calls.length, 2);
  await f.reopen();
  const duplicate = await f.request("conversation.chat.submit", input);
  assert.ok(duplicate.success && duplicate.result.submissionId === submitted.result.submissionId);
  assert.equal(f.calls.length, 2);
  const history = await f.request("conversation.entries", { conversationId: f.conversation.id, limit: 20 });
  assert.ok(history.success);
  assert.match(JSON.stringify(history.result), /pi.tool-result/);
  assert.match(JSON.stringify(history.result), /你好，Python/);
  f.setScript('print("private_value" in globals())', false, "python");
  const fresh = await f.request("conversation.chat.submit", { ...f.input(), sandbox: true });
  assert.ok(fresh.success);
  assert.equal((await f.settled(fresh.result.submissionId)).status, "done");
  const latest = f.calls.at(-1)?.messages as { role: string; content: string }[];
  assert.match([...latest].reverse().find(message => message.role === "tool")?.content ?? "", /False/);
});

test("Python sandbox bounds memory, output and execution time, supports cancellation and recovers", { timeout: 30_000 }, async context => {
  const f = await fixture(context);
  async function run(code: string) {
    f.setScript(code, false, "python");
    const submitted = await f.request("conversation.chat.submit", { ...f.input(), sandbox: true });
    assert.ok(submitted.success);
    assert.equal((await f.settled(submitted.result.submissionId)).status, "done");
    const messages = f.calls.at(-1)?.messages as { role: string; content: string }[];
    return [...messages].reverse().find(message => message.role === "tool")?.content ?? "";
  }
  assert.match(await run("data = bytearray(512 * 1024 * 1024)"), /MemoryError/);
  const output = await run('print("x" * 100000)');
  assert.match(output, /output limit/i);
  assert.ok(Buffer.byteLength(output) <= 16 * 1024);
  assert.match(await run("while True: pass"), /timed out/i);
  f.setScript("while True: pass", false, "python");
  const running = await f.request("conversation.chat.submit", { ...f.input(), sandbox: true });
  assert.ok(running.success);
  const deadline = Date.now() + 5000;
  while (true) {
    const status = await f.request("conversation.chat.status", { conversationId: f.conversation.id });
    assert.ok(status.success);
    if (status.result.phase === "computing") break;
    assert.ok(Date.now() < deadline);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok((await f.request("conversation.chat.abort", { conversationId: f.conversation.id })).success);
  assert.equal((await f.settled(running.result.submissionId)).status, "unanswered");
  assert.match(await run("print(6 * 7)"), /42/);
  const isolated = spawn(process.execPath, ["--max-old-space-size=128", "--wasm-max-mem-pages=4096",
    fileURLToPath(new URL("./python-runner.mjs", import.meta.url))], { env: {}, windowsHide: true });
  context.after(() => { if (isolated.exitCode === null) isolated.kill(); });
  isolated.stdin.end("while True: pass");
  assert.equal((await once(isolated, "close"))[0], 124, "the child deadline survives without the Runtime watchdog");
});

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

test("native streamed thinking is bounded, excludes redacted payloads and survives completed history reopen", { timeout: 20_000 }, async (context) => {
  const f = await fixture(context);
  const thinking = "预览之前" + "思".repeat(12000) + "思考末尾";
  f.enableThinking(thinking); f.setMode("slow");
  const submitted = await f.request("conversation.chat.submit", f.input());
  assert.ok(submitted.success);
  const deadline = Date.now() + 5000;
  while (true) {
    const status = await f.request("conversation.chat.status", { conversationId: f.conversation.id });
    assert.ok(status.success);
    if (status.result.phase === "thinking") {
      assert.equal(status.result.partialThinking, thinking.slice(-12000));
      assert.equal(status.result.thinkingTruncated, true);
      assert.equal(status.result.partialText, "");
      break;
    }
    assert.ok(Date.now() < deadline, "native thinking reaches committed status");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await f.host.harness.commit(async tx => {
    const live = await tx.doc(LiveDoc, f.conversation.id as ConversationId);
    assert.ok(live.generation?.message);
    live.generation.message.content.push({ type: "thinking", thinking: "redacted-private-payload", redacted: true, thinkingSignature: "opaque-signature" });
  }, BACKGROUND_CONTEXT);
  const filtered = await f.request("conversation.chat.status", { conversationId: f.conversation.id });
  assert.ok(filtered.success);
  assert.equal(JSON.stringify(filtered).includes("redacted-private-payload"), false);
  assert.equal(JSON.stringify(filtered).includes("opaque-signature"), false);
  f.finishThinking();
  assert.equal((await f.settled(submitted.result.submissionId)).status, "done");
  await f.reopen();
  const idle = await f.request("conversation.chat.status", { conversationId: f.conversation.id });
  assert.ok(idle.success);
  assert.equal(idle.result.phase, null);
  assert.equal(idle.result.partialThinking, "");
  assert.equal(idle.result.thinkingTruncated, false);
  const history = await f.request("conversation.entries", { conversationId: f.conversation.id });
  assert.ok(history.success);
  assert.ok(JSON.stringify(history.result).includes(thinking), "preview limits do not truncate Durable history");
  const conversation = await f.host.conversation(f.conversation.id as ConversationId);
  assert.ok(conversation);
  const nativeHistory = await conversation.entries({}, 20, undefined, BACKGROUND_CONTEXT);
  const assistant = nativeHistory.items.flatMap(entry => entry.model ?? []).find(message => message.role === "assistant");
  assert.ok(assistant?.role === "assistant");
  assert.ok(typeof assistant.durationMs === "number" && Number.isFinite(assistant.durationMs) && assistant.durationMs >= 0,
    "the native stream duration is preserved through policy forwarding, Durable storage and reopen");
  assert.equal(f.calls.length, 1);
});

test("text-only streaming reports responding and abort clears the live projection", { timeout: 20_000 }, async (context) => {
  const f = await fixture(context);
  f.setMode("slow");
  const submitted = await f.request("conversation.chat.submit", f.input());
  assert.ok(submitted.success);
  const deadline = Date.now() + 5000;
  while (true) {
    const status = await f.request("conversation.chat.status", { conversationId: f.conversation.id });
    assert.ok(status.success);
    if (status.result.phase === "responding") {
      assert.equal(status.result.partialText, "本地回复");
      assert.equal(status.result.partialThinking, "");
      break;
    }
    assert.ok(Date.now() < deadline);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await f.request("conversation.chat.abort", { conversationId: f.conversation.id });
  await f.settled(submitted.result.submissionId);
  const stopped = await f.request("conversation.chat.status", { conversationId: f.conversation.id });
  assert.ok(stopped.success);
  assert.equal(stopped.result.phase, null);
  assert.equal(stopped.result.partialText, "");
  assert.equal(stopped.result.partialThinking, "");
});

test("thinking levels reach the native request and survive resume, reopen and idempotent retry", { timeout: 20_000 }, async (context) => {
  const f = await fixture(context);
  function reasoningModel() {
    const provider = f.host.models.getProvider(f.config.id);
    assert.ok(provider);
    const models = provider.getModels();
    f.host.models.setProvider({ ...provider, getModels: () => models.map(model => ({
      ...model, reasoning: true,
      thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null },
      compat: { ...model.compat, supportsReasoningEffort: true },
    })) });
  }
  reasoningModel();
  f.setMode("error");
  const input = { ...f.input(), thinkingLevel: "high" };
  const first = await f.request("conversation.chat.submit", input);
  assert.ok(first.success);
  assert.equal((await f.settled(first.result.submissionId)).status, "unanswered");
  assert.equal(f.calls[0]?.reasoning_effort, "high");
  await f.reopen();
  reasoningModel();
  const status = await f.request("conversation.chat.status", { conversationId: f.conversation.id });
  assert.ok(status.success);
  assert.equal(status.result.thinkingLevel, "high");
  assert.equal(status.result.canResume, true);
  f.setMode("success");
  const resumed = await f.request("conversation.chat.resume", { conversationId: f.conversation.id, requestId: randomUUID() });
  assert.ok(resumed.success);
  assert.equal((await f.settled(resumed.result.submissionId)).status, "done");
  assert.equal(f.calls[1]?.reasoning_effort, "high");
  const conflict = await f.request("conversation.chat.submit", { ...input, thinkingLevel: "low" });
  assert.ok(!conflict.success);
  assert.equal(conflict.error.code, "REQUEST_ID_CONFLICT");
  await f.credentials.delete(f.config.id);
  f.host.models.deleteProvider(f.config.id);
  const retry = await f.request("conversation.chat.submit", input);
  assert.ok(retry.success);
  assert.equal(retry.result.submissionId, first.result.submissionId);
  assert.equal(f.calls.length, 2);
  const agent = await f.host.harness.snapshot(AgentDoc, f.conversation.id as ConversationId, BACKGROUND_CONTEXT);
  assert.equal(agent?.thinkingLevel, "high");
});

test("invalid or unsupported thinking levels leave conversation state unchanged and do not call models", { timeout: 20_000 }, async (context) => {
  const f = await fixture(context);
  for (const [thinkingLevel, code] of [["high", "THINKING_LEVEL_UNSUPPORTED"], ["auto", "INVALID_PARAMS"], [42, "INVALID_PARAMS"], [null, "INVALID_PARAMS"]]) {
    const result = await f.request("conversation.chat.submit", { ...f.input(), thinkingLevel });
    assert.ok(!result.success);
    assert.equal(result.error.code, code);
  }
  const status = await f.request("conversation.chat.status", { conversationId: f.conversation.id });
  assert.ok(status.success);
  assert.equal(status.result.latestEntryId, null);
  assert.equal(f.calls.length, 0);
  const input = f.input();
  const first = await f.request("conversation.chat.submit", input);
  assert.ok(first.success);
  await f.settled(first.result.submissionId);
  const retry = await f.request("conversation.chat.submit", { ...input, thinkingLevel: "off" });
  assert.ok(retry.success);
  assert.equal(retry.result.submissionId, first.result.submissionId);
});

test("legacy input without thinking metadata still deduplicates after reopen", { timeout: 20_000 }, async (context) => {
  const f = await fixture(context);
  const input = f.input();
  const conversation = await f.host.conversation(f.conversation.id as ConversationId);
  assert.ok(conversation);
  const submissionId = await f.host.harness.commit(tx => conversation.submit(tx, {
    type: "input", requestId: input.requestId, content: input.content,
    entry: { kind: "studio.chat-input", data: { providerId: input.providerId, modelId: input.modelId } },
  }), BACKGROUND_CONTEXT);
  f.host.harness.resume();
  await f.settled(submissionId);
  await f.reopen();
  await f.credentials.delete(f.config.id);
  const retry = await f.request("conversation.chat.submit", input);
  assert.ok(retry.success);
  assert.equal(retry.result.submissionId, submissionId);
  const explicitOff = await f.request("conversation.chat.submit", { ...input, thinkingLevel: "off" });
  assert.ok(explicitOff.success);
  assert.equal(explicitOff.result.submissionId, submissionId);
  const conflict = await f.request("conversation.chat.submit", { ...input, thinkingLevel: "high" });
  assert.ok(!conflict.success);
  assert.equal(conflict.error.code, "REQUEST_ID_CONFLICT");
  assert.equal(f.calls.length, 0);
});

test("model capability changes during credential lookup are rejected before submission", { timeout: 20_000 }, async (context) => {
  const f = await fixture(context);
  const checkAuth = f.host.models.checkAuth.bind(f.host.models);
  context.mock.method(f.host.models, "checkAuth", async (...args: Parameters<typeof checkAuth>) => {
    const auth = await checkAuth(...args);
    const provider = f.host.models.getProvider(f.config.id);
    assert.ok(provider);
    const models = provider.getModels();
    f.host.models.setProvider({ ...provider, getModels: () => models.map(model => ({ ...model, reasoning: true, thinkingLevelMap: { off: null } })) });
    return auth;
  });
  const result = await f.request("conversation.chat.submit", f.input());
  assert.ok(!result.success);
  assert.equal(result.error.code, "THINKING_LEVEL_UNSUPPORTED");
  const status = await f.request("conversation.chat.status", { conversationId: f.conversation.id });
  assert.ok(status.success);
  assert.equal(status.result.latestEntryId, null);
  assert.equal(f.calls.length, 0);
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
  for (const method of ["conversation.chat.submit", "conversation.chat.status", "conversation.chat.abort", "conversation.chat.resume", "conversation.usage", "conversation.context.usage", "conversation.context.reset"]) {
    const input = method.endsWith("submit") ? { ...f.input(), conversationId: root.id } : method.endsWith("resume") || method.endsWith("reset") ? { conversationId: root.id, requestId: randomUUID() } : { conversationId: root.id };
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

test("context usage reads the last request including cache, not cumulative spend, without auth or model calls", { timeout: 20_000 }, async (context) => {
  const f = await fixture(context);
  const empty = await f.request("conversation.context.usage", { conversationId: f.conversation.id });
  assert.ok(empty.success);
  assert.equal(empty.result.state, "empty");
  assert.equal(empty.result.lastRequest, null);
  f.enableUsage();
  for (const content of ["第一轮", "第二轮"]) {
    const sent = await f.request("conversation.chat.submit", f.input(content));
    assert.ok(sent.success);
    await f.settled(sent.result.submissionId);
  }
  const measured = await f.request("conversation.context.usage", { conversationId: f.conversation.id });
  assert.ok(measured.success);
  assert.equal(measured.result.state, "reported");
  assert.deepEqual(measured.result.lastRequest, {
    providerId: f.config.id, modelId: f.config.modelId, inputTokens: 12, outputTokens: 5,
    cacheReadTokens: 2, cacheWriteTokens: 0, reasoningTokens: 3, contextWindow: 32768,
  });
  assert.equal(JSON.stringify(measured).includes("synthetic-chat-secret"), false);
  await f.reopen();
  await f.credentials.delete(f.config.id);
  const restored = await f.request("conversation.context.usage", { conversationId: f.conversation.id });
  assert.ok(restored.success);
  assert.deepEqual(restored.result, measured.result);
  f.host.models.deleteProvider(f.config.id);
  const missingCatalog = await f.request("conversation.context.usage", { conversationId: f.conversation.id });
  assert.ok(missingCatalog.success);
  assert.deepEqual(missingCatalog.result.lastRequest, { ...measured.result.lastRequest as object, contextWindow: null });
  assert.equal(f.calls.length, 2);
  for (const params of [{}, { conversationId: -1 }, { conversationId: f.conversation.id, apiKey: "private" }]) {
    const invalid = await f.request("conversation.context.usage", params);
    assert.ok(!invalid.success);
    assert.equal(invalid.error.code, "INVALID_PARAMS");
  }
});

test("context usage respects native reset and fork boundaries and does not inherit cumulative totals", { timeout: 20_000 }, async (context) => {
  const f = await fixture(context);
  f.enableUsage();
  const sent = await f.request("conversation.chat.submit", f.input());
  assert.ok(sent.success);
  await f.settled(sent.result.submissionId);
  const source = await f.host.conversation(f.conversation.id as ConversationId);
  assert.ok(source);
  const entries = await source.entries({}, 20, undefined, BACKGROUND_CONTEXT);
  const answer = entries.items.find(entry => entry.kind === "pi.assistant");
  assert.ok(answer);
  const fork = await f.request("conversation.fork", { conversationId: f.conversation.id, entryId: answer.id, requestId: randomUUID() });
  assert.ok(fork.success);
  const child = fork.result.conversation as { id: number };
  const inherited = await f.request("conversation.context.usage", { conversationId: child.id });
  assert.ok(inherited.success);
  assert.equal(inherited.result.state, "reported");
  const reset = await f.request("conversation.context.reset", { conversationId: f.conversation.id, requestId: randomUUID() });
  assert.ok(reset.success);
  const cleared = await f.request("conversation.context.usage", { conversationId: f.conversation.id });
  assert.ok(cleared.success);
  assert.equal(cleared.result.state, "empty");
  assert.equal(cleared.result.lastRequest, null);
  const childAgain = await f.request("conversation.context.usage", { conversationId: child.id });
  assert.ok(childAgain.success);
  assert.deepEqual(childAgain.result, inherited.result);
  const totals = await f.request("conversation.usage", { conversationId: f.conversation.id });
  assert.ok(totals.success);
  assert.ok(Array.isArray(totals.result.items));
  assert.equal(totals.result.items[0].totalTokens, 17);
  assert.equal(f.calls.length, 1);
});

test("missing latest usage is unreported instead of zero or an older request, and stopped responses stay excluded", { timeout: 20_000 }, async (context) => {
  const f = await fixture(context);
  f.enableUsage();
  const first = await f.request("conversation.chat.submit", f.input());
  assert.ok(first.success);
  await f.settled(first.result.submissionId);
  f.setMode("slow");
  const stopped = await f.request("conversation.chat.submit", f.input("停止这轮"));
  assert.ok(stopped.success);
  await f.request("conversation.chat.abort", { conversationId: f.conversation.id });
  await f.settled(stopped.result.submissionId);
  const prior = await f.request("conversation.context.usage", { conversationId: f.conversation.id });
  assert.ok(prior.success);
  assert.equal(prior.result.state, "reported");
  f.disableUsage(); f.setMode("success");
  const next = await f.request("conversation.chat.submit", f.input("不报告用量"));
  assert.ok(next.success);
  await f.settled(next.result.submissionId);
  const unreported = await f.request("conversation.context.usage", { conversationId: f.conversation.id });
  assert.ok(unreported.success);
  assert.equal(unreported.result.state, "unreported");
  assert.equal(unreported.result.lastRequest, null);
});

test("conversation usage reads native whole-history totals, remains isolated and survives reopen without auth or model calls", { timeout: 20_000 }, async (context) => {
  const f = await fixture(context);
  f.enableUsage();
  const empty = await f.request("conversation.usage", { conversationId: f.conversation.id });
  assert.ok(empty.success);
  assert.deepEqual(empty.result, { items: [], nextAfterModel: null });
  const inputs = [f.input("统计第一轮"), f.input("统计第二轮")];
  for (const input of inputs) {
    const submitted = await f.request("conversation.chat.submit", input);
    assert.ok(submitted.success);
    assert.equal((await f.settled(submitted.result.submissionId)).status, "done");
  }
  const retry = await f.request("conversation.chat.submit", inputs[0]!);
  assert.ok(retry.success);
  const usage = await f.request("conversation.usage", { conversationId: f.conversation.id });
  assert.ok(usage.success);
  const native = await f.host.harness.snapshot(UsageDoc, f.conversation.id as ConversationId, BACKGROUND_CONTEXT);
  const key = `${f.config.id}/${f.config.modelId}`;
  assert.ok(native?.models[key]);
  assert.equal(native.models[key].totalTokens, 34);
  assert.deepEqual(usage.result, { items: [{
    model: key, inputTokens: native.models[key].input, outputTokens: 10,
    cacheReadTokens: 4, cacheWriteTokens: 0, reasoningTokens: 6, totalTokens: 34, costUsd: null,
  }], nextAfterModel: null });
  await f.reopen();
  await f.credentials.delete(f.config.id);
  const reopened = await f.request("conversation.usage", { conversationId: f.conversation.id });
  assert.ok(reopened.success);
  assert.deepEqual(reopened.result, usage.result);
  const other = await createUserConversation(f.host.harness, randomUUID(), "独立用量");
  const isolated = await f.request("conversation.usage", { conversationId: other.id });
  assert.ok(isolated.success);
  assert.deepEqual(isolated.result, { items: [], nextAfterModel: null });
  assert.equal(f.calls.length, 2);
});

test("conversation usage paginates native model buckets and exposes only valid public counters", { timeout: 20_000 }, async (context) => {
  const f = await fixture(context);
  await f.host.harness.commit(async (tx) => {
    const ledger = await tx.doc(UsageDoc, f.conversation.id as ConversationId);
    for (let i = 0; i < 51; i++) ledger.models[`model-${String(i).padStart(3, "0")}`] = {
      input: i === 0 ? -1 : 12, output: 5, cacheRead: 2, cacheWrite: 0, totalTokens: 19,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: i === 1 ? -1 : 0.003 },
    };
    Object.assign(ledger.models["model-000"]!, { privateField: "synthetic-usage-private" });
  }, BACKGROUND_CONTEXT);
  const first = await f.request("conversation.usage", { conversationId: f.conversation.id, limit: 50 });
  assert.ok(first.success);
  assert.ok(Array.isArray(first.result.items));
  assert.equal(first.result.items.length, 50);
  assert.equal(first.result.nextAfterModel, "model-049");
  assert.deepEqual(first.result.items[0], {
    model: "model-000", inputTokens: null, outputTokens: 5, cacheReadTokens: 2,
    cacheWriteTokens: 0, reasoningTokens: null, totalTokens: 19, costUsd: 0.003,
  });
  assert.equal(first.result.items[1].costUsd, null);
  assert.equal(JSON.stringify(first).includes("synthetic-usage-private"), false);
  const next = await f.request("conversation.usage", { conversationId: f.conversation.id, afterModel: "model-049" });
  assert.ok(next.success);
  assert.ok(Array.isArray(next.result.items));
  assert.equal(next.result.items.length, 1);
  assert.equal(next.result.items[0].model, "model-050");
  assert.equal(next.result.nextAfterModel, null);
  for (const params of [{}, { conversationId: f.conversation.id, limit: 51 }, { conversationId: f.conversation.id, afterModel: 42 },
    { conversationId: f.conversation.id, extra: true }, { conversationId: f.conversation.id, afterModel: "x".repeat(1025) }]) {
    const invalid = await f.request("conversation.usage", params);
    assert.ok(!invalid.success);
    assert.equal(invalid.error.code, "INVALID_PARAMS");
  }
  assert.equal(f.calls.length, 0);
});

test("stopping after usage is reported keeps the native attempt counters through error sanitization", { timeout: 20_000 }, async (context) => {
  const f = await fixture(context);
  f.enableUsage(); f.setMode("slow");
  const submitted = await f.request("conversation.chat.submit", f.input());
  assert.ok(submitted.success);
  const deadline = Date.now() + 5000;
  while (true) {
    const live = await f.host.harness.snapshot(LiveDoc, f.conversation.id as ConversationId, BACKGROUND_CONTEXT);
    if (live?.generation?.message?.usage.totalTokens === 17) break;
    assert.ok(Date.now() < deadline, "model usage reaches the native live message before stopping");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok((await f.request("conversation.chat.abort", { conversationId: f.conversation.id })).success);
  assert.equal((await f.settled(submitted.result.submissionId)).status, "unanswered");
  const usage = await f.request("conversation.usage", { conversationId: f.conversation.id });
  assert.ok(usage.success);
  assert.ok(Array.isArray(usage.result.items));
  assert.equal(usage.result.items[0].totalTokens, 17);
  assert.equal(usage.result.items[0].reasoningTokens, 3);
  const conversation = await f.host.conversation(f.conversation.id as ConversationId);
  assert.ok(conversation);
  const entries = await conversation.entries({}, 20, undefined, BACKGROUND_CONTEXT);
  assert.equal(JSON.stringify(entries).includes("synthetic-chat-secret"), false);
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

test("native context reset is idempotent across reopen and keeps transcript, model and usage while excluding old messages", { timeout: 20_000 }, async (context) => {
  const f = await fixture(context);
  f.enableUsage();
  const oldInput = f.input("旧上下文唯一标记");
  const first = await f.request("conversation.chat.submit", oldInput);
  assert.ok(first.success);
  await f.settled(first.result.submissionId);
  const conversation = await f.host.conversation(f.conversation.id as ConversationId);
  assert.ok(conversation);
  const before = await conversation.entries({ order: "ascending" }, 20, undefined, BACKGROUND_CONTEXT);
  const usageBefore = await f.request("conversation.usage", { conversationId: f.conversation.id });
  assert.ok(usageBefore.success);
  await f.credentials.delete(f.config.id);
  const input = { conversationId: f.conversation.id, requestId: randomUUID() };
  const [reset, duplicate] = await Promise.all([1, 2].map(() => f.request("conversation.context.reset", input)));
  assert.ok(reset.success && duplicate.success);
  assert.equal(reset.result.submissionId, duplicate.result.submissionId);
  assert.equal((await f.settled(reset.result.submissionId)).status, "done");
  const after = await conversation.entries({ order: "ascending" }, 20, undefined, BACKGROUND_CONTEXT);
  assert.deepEqual(after.items.slice(0, before.items.length), before.items);
  const resets = after.items.filter((entry) => entry.kind === "pi.reset");
  assert.equal(resets.length, 1);
  assert.equal(resets[0]?.head, resets[0]?.id);
  assert.equal(reset.result.entryId, resets[0]?.id);
  assert.deepEqual(duplicate.result, reset.result);
  assert.equal((await conversation.context(BACKGROUND_CONTEXT)).messages.length, 0);
  await f.reopen();
  const retried = await f.request("conversation.context.reset", input);
  assert.ok(retried.success);
  assert.equal(retried.result.submissionId, reset.result.submissionId);
  const usageAfter = await f.request("conversation.usage", { conversationId: f.conversation.id });
  assert.ok(usageAfter.success);
  assert.deepEqual(usageAfter.result, usageBefore.result);
  const status = await f.request("conversation.chat.status", { conversationId: f.conversation.id });
  assert.ok(status.success);
  assert.equal(status.result.contextReset, true);
  assert.equal(status.result.canResume, false);
  assert.deepEqual(status.result.model, { providerId: f.config.id, modelId: f.config.modelId });
  assert.equal(f.calls.length, 1, "reset and retries do not call the model or require credentials");
  const originalRetry = await f.request("conversation.chat.submit", oldInput);
  assert.ok(originalRetry.success);
  assert.equal(originalRetry.result.submissionId, first.result.submissionId);
  await f.credentials.modify(f.config.id, async () => ({ type: "api_key", key: "synthetic-chat-secret" }));
  const newInput = await f.request("conversation.chat.submit", f.input("新上下文的问题"));
  assert.ok(newInput.success);
  await f.settled(newInput.result.submissionId);
  assert.equal(f.calls.length, 2);
  assert.equal(JSON.stringify(f.calls[1]?.messages).includes("旧上下文唯一标记"), false);
  assert.equal(JSON.stringify(f.calls[1]?.messages).includes("本地回复完成"), false);
  assert.ok(JSON.stringify(f.calls[1]?.messages).includes("新上下文的问题"));
});

test("context reset rejects busy and invalid requests and prevents resuming the old failed context", { timeout: 20_000 }, async (context) => {
  const f = await fixture(context);
  f.setMode("slow");
  const input = f.input("准备停止与重置");
  const running = await f.request("conversation.chat.submit", input);
  assert.ok(running.success);
  const resetInput = { conversationId: f.conversation.id, requestId: randomUUID() };
  const busy = await f.request("conversation.context.reset", resetInput);
  assert.ok(!busy.success);
  assert.equal(busy.error.code, "CONVERSATION_BUSY");
  assert.ok((await f.request("conversation.chat.abort", { conversationId: f.conversation.id })).success);
  await f.settled(running.result.submissionId);
  const reset = await f.request("conversation.context.reset", resetInput);
  assert.ok(reset.success);
  const status = await f.request("conversation.chat.status", { conversationId: f.conversation.id });
  assert.ok(status.success);
  assert.equal(status.result.failureReason, null);
  assert.equal(status.result.canResume, false);
  const resume = await f.request("conversation.chat.resume", { conversationId: f.conversation.id, requestId: randomUUID() });
  assert.ok(!resume.success);
  assert.equal(resume.error.code, "CHAT_NOT_RESUMABLE");
  for (const [method, params] of [
    ["conversation.context.reset", { conversationId: f.conversation.id, requestId: input.requestId }],
    ["conversation.chat.submit", { ...input, requestId: resetInput.requestId }],
    ["conversation.chat.resume", resetInput],
  ] satisfies [string, Record<string, unknown>][]) {
    const conflict = await f.request(method, params);
    assert.ok(!conflict.success);
    assert.equal(conflict.error.code, "REQUEST_ID_CONFLICT");
  }
  for (const params of [{}, { conversationId: f.conversation.id }, { ...resetInput, requestId: "invalid" }, { ...resetInput, extra: true }]) {
    const invalid = await f.request("conversation.context.reset", params);
    assert.ok(!invalid.success);
    assert.equal(invalid.error.code, "INVALID_PARAMS");
  }
});


test("native fork is atomic and idempotent, inherits only selected history and model, and starts its own usage", { timeout: 20_000 }, async (context) => {
  const f = await fixture(context);
  f.enableUsage();
  const first = await f.request("conversation.chat.submit", f.input("分支之前唯一标记"));
  assert.ok(first.success);
  await f.settled(first.result.submissionId);
  const source = await f.host.conversation(f.conversation.id as ConversationId);
  assert.ok(source);
  const history = await source.entries({}, 20, undefined, BACKGROUND_CONTEXT);
  const boundary = history.items.find((entry) => entry.kind === "pi.assistant");
  assert.ok(boundary);
  const second = await f.request("conversation.chat.submit", f.input("分支之后不应继承的标记"));
  assert.ok(second.success);
  await f.settled(second.result.submissionId);
  const before = await source.entries({}, 20, undefined, BACKGROUND_CONTEXT);
  const originalUsage = await f.request("conversation.usage", { conversationId: source.id });
  await f.credentials.delete(f.config.id);
  const input = { conversationId: source.id, entryId: boundary.id, requestId: randomUUID() };
  const [fork, duplicate] = await Promise.all([f.request("conversation.fork", input), f.request("conversation.fork", input)]);
  assert.ok(fork.success && duplicate.success);
  assert.deepEqual(fork.result, duplicate.result);
  const child = fork.result.conversation as { id: number; title: string; forkedFrom: { conversationId: number; entryId: number } };
  assert.notEqual(child.id, source.id);
  assert.equal(child.title, "Chat test（分支）");
  assert.deepEqual(child.forkedFrom, { conversationId: source.id, entryId: boundary.id });
  const native = await f.host.conversation(child.id as ConversationId);
  assert.ok(native);
  assert.deepEqual(await native.entries({}, 20, undefined, BACKGROUND_CONTEXT), history);
  const status = await f.request("conversation.chat.status", { conversationId: child.id });
  assert.ok(status.success);
  assert.deepEqual(status.result.model, { providerId: f.config.id, modelId: f.config.modelId });
  assert.equal(status.result.running, false);
  assert.equal(status.result.canResume, false);
  const usage = await f.request("conversation.usage", { conversationId: child.id });
  assert.ok(usage.success);
  assert.deepEqual(usage.result, { items: [], nextAfterModel: null });
  assert.equal(f.calls.length, 2, "Creating a fork needs no credentials or model request");
  await f.reopen();
  const retry = await f.request("conversation.fork", input);
  assert.ok(retry.success);
  assert.deepEqual(retry.result, fork.result);
  const list = await f.request("conversation.list", {});
  assert.ok(list.success);
  assert.equal((list.result.items as { id: number }[]).length, 2);
  await f.credentials.modify(f.config.id, async () => ({ type: "api_key", key: "synthetic-chat-secret" }));
  const submitted = await f.request("conversation.chat.submit", { ...f.input("分支自己的问题"), conversationId: child.id });
  assert.ok(submitted.success);
  assert.equal((await f.settled(submitted.result.submissionId)).status, "done");
  const messages = JSON.stringify(f.calls[2]?.messages);
  assert.ok(messages.includes("分支之前唯一标记"));
  assert.ok(messages.includes("本地回复完成"));
  assert.ok(messages.includes("分支自己的问题"));
  assert.equal(messages.includes("分支之后不应继承的标记"), false);
  const reopenedSource = await f.host.conversation(source.id);
  assert.ok(reopenedSource);
  assert.deepEqual(await reopenedSource.entries({}, 20, undefined, BACKGROUND_CONTEXT), before);
  const afterUsage = await f.request("conversation.usage", { conversationId: source.id });
  assert.ok(afterUsage.success && originalUsage.success);
  assert.deepEqual(afterUsage.result, originalUsage.result);
  const childUsage = await f.request("conversation.usage", { conversationId: child.id });
  assert.ok(childUsage.success);
  assert.equal((childUsage.result.items as { totalTokens: number }[])[0]?.totalTokens, 17);
});

test("fork rejects invisible, foreign, unfinished entries and request conflicts without creating conversations", { timeout: 20_000 }, async (context) => {
  const f = await fixture(context);
  const submitted = await f.request("conversation.chat.submit", f.input());
  assert.ok(submitted.success);
  await f.settled(submitted.result.submissionId);
  const source = await f.host.conversation(f.conversation.id as ConversationId);
  assert.ok(source);
  const entries = await source.entries({}, 20, undefined, BACKGROUND_CONTEXT);
  const assistant = entries.items.find((entry) => entry.kind === "pi.assistant");
  const user = entries.items.find((entry) => entry.kind === "studio.chat-input");
  assert.ok(assistant && user);
  const createId = randomUUID();
  const other = await createUserConversation(f.host.harness, createId, "Other");
  const root = await f.host.root();
  for (const conversationId of [root.id, 999999]) {
    const result = await f.request("conversation.fork", { conversationId, entryId: assistant.id, requestId: randomUUID() });
    assert.ok(!result.success);
    assert.equal(result.error.code, "CONVERSATION_NOT_FOUND");
  }
  for (const input of [
    { conversationId: other.id, entryId: assistant.id },
    { conversationId: source.id, entryId: user.id },
    { conversationId: source.id, entryId: 999999 },
  ]) {
    const result = await f.request("conversation.fork", { ...input, requestId: randomUUID() });
    assert.ok(!result.success);
    assert.equal(result.error.code, "FORK_ENTRY_INVALID");
  }
  for (const bad of [{ entryId: -1 }, { requestId: "bad" }, { apiKey: "synthetic" }]) {
    const result = await f.request("conversation.fork", { conversationId: source.id, entryId: assistant.id, requestId: randomUUID(), ...bad });
    assert.ok(!result.success);
    assert.equal(result.error.code, "INVALID_PARAMS");
  }
  const conflict = await f.request("conversation.fork", { conversationId: source.id, entryId: assistant.id, requestId: createId });
  assert.ok(!conflict.success);
  assert.equal(conflict.error.code, "REQUEST_ID_CONFLICT");
  const input = { conversationId: source.id, entryId: assistant.id, requestId: randomUUID() };
  const fork = await f.request("conversation.fork", input);
  assert.ok(fork.success);
  const wrongEntry = await f.request("conversation.fork", { ...input, entryId: user.id });
  assert.ok(!wrongEntry.success);
  assert.equal(wrongEntry.error.code, "REQUEST_ID_CONFLICT");
  const wrongOperation = await f.request("conversation.create", { requestId: input.requestId });
  assert.ok(!wrongOperation.success);
  assert.equal(wrongOperation.error.code, "REQUEST_ID_CONFLICT");
  const child = fork.result.conversation as { id: number };
  const nested = await f.request("conversation.fork", { conversationId: child.id, entryId: assistant.id, requestId: randomUUID() });
  assert.ok(nested.success, "An inherited visible reply can be forked again");
  const list = await f.request("conversation.list", {});
  assert.ok(list.success);
  assert.equal((list.result.items as unknown[]).length, 4, "Rejected attempts must not leave indexed or orphaned forks");
  const records = await f.host.harness.commit((tx) => tx.scanConversations({}, 100), BACKGROUND_CONTEXT);
  assert.equal(records.items.length, 5, "Four user conversations and one hidden root");
});


test("forking an earlier reply leaves the active source run alone and rejects aborted and post-boundary replies", { timeout: 20_000 }, async (context) => {
  const f = await fixture(context);
  const first = await f.request("conversation.chat.submit", f.input());
  assert.ok(first.success);
  await f.settled(first.result.submissionId);
  const source = await f.host.conversation(f.conversation.id as ConversationId);
  assert.ok(source);
  const initial = await source.entries({}, 20, undefined, BACKGROUND_CONTEXT);
  const boundary = initial.items.find((entry) => entry.kind === "pi.assistant");
  assert.ok(boundary);
  f.setMode("slow");
  const running = await f.request("conversation.chat.submit", f.input("原会话仍在生成"));
  assert.ok(running.success);
  const fork = await f.request("conversation.fork", { conversationId: source.id, entryId: boundary.id, requestId: randomUUID() });
  assert.ok(fork.success);
  const child = fork.result.conversation as { id: number };
  const sourceStatus = await f.request("conversation.chat.status", { conversationId: source.id });
  const childStatus = await f.request("conversation.chat.status", { conversationId: child.id });
  assert.ok(sourceStatus.success && childStatus.success);
  assert.equal(sourceStatus.result.running, true);
  assert.equal(childStatus.result.running, false);
  await f.request("conversation.chat.abort", { conversationId: source.id });
  await f.settled(running.result.submissionId);
  const stopped = await source.entries({}, 20, undefined, BACKGROUND_CONTEXT);
  const aborted = stopped.items.find((entry) => entry.kind === "pi.assistant" && entry.id > boundary.id);
  if (aborted) {
    const result = await f.request("conversation.fork", { conversationId: source.id, entryId: aborted.id, requestId: randomUUID() });
    assert.ok(!result.success);
    assert.equal(result.error.code, "FORK_ENTRY_INVALID");
  }
  f.setMode("success");
  const later = await f.request("conversation.chat.submit", f.input("分支点之后的完整回复"));
  assert.ok(later.success);
  await f.settled(later.result.submissionId);
  const latest = await source.entries({}, 1, undefined, BACKGROUND_CONTEXT);
  assert.equal(latest.items[0]?.kind, "pi.assistant");
  const invisible = await f.request("conversation.fork", { conversationId: child.id, entryId: latest.items[0]!.id, requestId: randomUUID() });
  assert.ok(!invisible.success);
  assert.equal(invisible.error.code, "FORK_ENTRY_INVALID", "Parent history after the fork boundary is invisible in the child");
});
