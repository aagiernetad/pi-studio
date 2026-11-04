
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import { RuntimeHandlerRegistry } from "../handlers/registry.js";
import { RuntimeRequestDispatcher } from "../handlers/dispatcher.js";
import { registerRuntimeHandlers } from "../handlers/runtime.js";

import {
  JsonlServer,
  type JsonlServerOptions,
} from "./jsonl-server.js";

import { JsonlWriter } from "./jsonl-writer.js";

// ========================================
// 1. 测试数据类型与工具函数
// ========================================

interface TestMessage {
  version: number;
  kind: string;
  id?: string;
  success?: boolean;
  result?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
}

function createRequest(
  id: string,
  method: string,
  params: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    version: 1,
    kind: "request",
    id,
    method,
    params,
  }) + "\n";
}

function createTestServer(
  input: Readable,
  register?: (registry: RuntimeHandlerRegistry) => void,
  options: Partial<JsonlServerOptions> = {},
) {
  const messages: TestMessage[] = [];

  const output = new Writable({
    write(chunk, _encoding, callback) {
      const line = chunk.toString("utf8").trim();

      messages.push(
        JSON.parse(line) as TestMessage,
      );

      callback();
    },
  });

  const registry = new RuntimeHandlerRegistry();

  registerRuntimeHandlers(registry);
  register?.(registry);

  const dispatcher = new RuntimeRequestDispatcher(
    registry,
  );

  const server = new JsonlServer(dispatcher, {
    input,
    output,
    maxConcurrentRequests: 8,
    requestTimeoutMs: 1_000,
    shutdownGraceMs: 250,
    log: () => {},
    ...options,
  });

  return {
    server,
    messages,
  };
}

function findResponse(
  messages: TestMessage[],
  id: string,
): TestMessage {
  const response = messages.find(
    (message) =>
      message.kind === "response" &&
      message.id === id,
  );

  assert.ok(response, `Missing response: ${id}`);

  return response;
}

// ========================================
// 2. Runtime 可靠性测试
// ========================================

describe("Runtime Reliability", () => {

  // ----------------------------------------
  // Test 1：不同请求能够并发完成
  // ----------------------------------------

  it("should execute independent requests concurrently", async () => {
    const input = Readable.from([
      createRequest("slow-001", "runtime.slow"),
      createRequest("fast-001", "runtime.ping"),
    ]);

    const { server, messages } = createTestServer(
      input,
      (registry) => {
        registry.register("runtime.slow", async () => {
          await delay(60);

          return {
            message: "slow finished",
          };
        });
      },
      {
        shutdownGraceMs: 500,
      },
    );

    await server.run();

    assert.equal(messages.length, 2);

    const slow = findResponse(messages, "slow-001");
    const fast = findResponse(messages, "fast-001");

    assert.equal(slow.success, true);
    assert.equal(fast.success, true);

    // 快请求应该先于慢请求完成
    assert.equal(messages[0].id, "fast-001");
    assert.equal(messages[1].id, "slow-001");
  });

  // ----------------------------------------
  // Test 2：并发上限
  // ----------------------------------------

  it("should reject requests when concurrency limit is reached", async () => {
    let notifyStarted!: () => void;

    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });

    async function* input() {
      yield createRequest(
        "work-001",
        "runtime.hold",
      );

      // 确保第一个 Handler 已经启动
      await started;

      // 此时并发上限为 1
      yield createRequest(
        "work-002",
        "runtime.ping",
      );

      // 取消第一个请求，完成测试清理
      yield createRequest(
        "cancel-001",
        "runtime.cancel",
        { targetRequestId: "work-001" },
      );
    }

    const { server, messages } = createTestServer(
      Readable.from(input()),
      (registry) => {
        registry.register("runtime.hold", () => {
          notifyStarted();

          return new Promise<Record<string, unknown>>(
            () => {},
          );
        });
      },
      {
        maxConcurrentRequests: 1,
      },
    );

    await server.run();

    const busy = findResponse(messages, "work-002");

    assert.equal(busy.success, false);
    assert.equal(busy.error?.code, "SERVER_BUSY");

    const cancelled = findResponse(
      messages,
      "work-001",
    );

    assert.equal(cancelled.success, false);
    assert.equal(
      cancelled.error?.code,
      "REQUEST_CANCELLED",
    );
  });

  // ----------------------------------------
  // Test 3：请求执行超时
  // ----------------------------------------

  it("should timeout a stalled handler", async () => {
    const input = Readable.from([
      createRequest(
        "timeout-001",
        "runtime.hold",
      ),
    ]);

    const { server, messages } = createTestServer(
      input,
      (registry) => {
        registry.register(
          "runtime.hold",
          () =>
            new Promise<Record<string, unknown>>(
              () => {},
            ),
        );
      },
      {
        requestTimeoutMs: 40,
        shutdownGraceMs: 300,
      },
    );

    await server.run();

    const response = findResponse(
      messages,
      "timeout-001",
    );

    assert.equal(response.success, false);
    assert.equal(
      response.error?.code,
      "REQUEST_TIMEOUT",
    );
  });

  // ----------------------------------------
  // Test 4：关闭时取消未完成请求
  // ----------------------------------------

  it("should cancel unfinished requests during shutdown", async () => {
    const input = Readable.from([
      createRequest(
        "shutdown-001",
        "runtime.hold",
      ),
    ]);

    const { server, messages } = createTestServer(
      input,
      (registry) => {
        registry.register(
          "runtime.hold",
          () =>
            new Promise<Record<string, unknown>>(
              () => {},
            ),
        );
      },
      {
        requestTimeoutMs: 5_000,
        shutdownGraceMs: 30,
      },
    );

    // 输入流关闭后，Server 进入 shutdown
    await server.run();

    const response = findResponse(
      messages,
      "shutdown-001",
    );

    assert.equal(response.success, false);
    assert.equal(
      response.error?.code,
      "RUNTIME_SHUTDOWN",
    );
  });

  // ----------------------------------------
  // Test 5：输出队列背压保护
  // ----------------------------------------

  it("should reject writes when outbound queue is full", async () => {
    let completeWrite:
      | ((error?: Error | null) => void)
      | undefined;

    // 模拟暂时不消费数据的输出流
    const output = new Writable({
      highWaterMark: 1,

      write(_chunk, _encoding, callback) {
        completeWrite = callback;
      },
    });

    // 测试队列容量限制为 1
    const writer = new JsonlWriter(output, 1);

    const firstWrite = writer.send({
      id: "message-001",
    });

    // 让第一条写入进入 Writable
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    assert.ok(completeWrite);

    // 第一条仍在等待，第二条应被拒绝
    await assert.rejects(
      writer.send({
        id: "message-002",
      }),
      /IPC_OUTBOUND_QUEUE_FULL/,
    );

    // 模拟输出流恢复消费
    completeWrite();

    await firstWrite;
    await writer.flush();

    output.destroy();
  });

});
