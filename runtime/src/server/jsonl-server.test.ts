
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Readable, Writable } from "node:stream";

import { RuntimeHandlerRegistry } from "../handlers/registry.js";
import { RuntimeRequestDispatcher } from "../handlers/dispatcher.js";
import { registerRuntimeHandlers } from "../handlers/runtime.js";

import {
  JsonlServer,
  type JsonlServerOptions,
} from "./jsonl-server.js";

import type { RuntimeRequest } from "../protocol/messages.js";

function request(
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

async function execute(
  input: Readable,
  register?: (registry: RuntimeHandlerRegistry) => void,
  options: Partial<JsonlServerOptions> = {},
) {
  const chunks: string[] = [];
  const logs: string[] = [];

  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString("utf8"));
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
    shutdownGraceMs: 100,
    log: (message) => logs.push(message),
    ...options,
  });

  await server.run();

  const messages = chunks
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  return { messages, logs };
}

describe("JsonlServer integration", () => {
  it("should handle ping requests", async () => {
    const { messages } = await execute(
      Readable.from([
        request("req-001", "runtime.ping", {
          message: "Hello Pi Studio",
        }),
      ]),
    );

    assert.equal(messages.length, 1);
    assert.equal(messages[0].id, "req-001");
    assert.equal(messages[0].success, true);

    assert.equal(
      messages[0].result.message,
      "Hello Pi Studio",
    );
  });

  it("should handle split input chunks", async () => {
    const line = request(
      "req-split",
      "runtime.ping",
    );

    const middle = Math.floor(line.length / 2);

    const { messages } = await execute(
      Readable.from([
        Buffer.from(line.slice(0, middle)),
        Buffer.from(line.slice(middle)),
      ]),
    );

    assert.equal(messages.length, 1);
    assert.equal(messages[0].success, true);
    assert.equal(messages[0].id, "req-split");
  });

  it("should reject duplicate IDs", async () => {
    const { messages } = await execute(
      Readable.from([
        request("duplicate", "runtime.ping"),
        request("duplicate", "runtime.ping"),
      ]),
    );

    assert.equal(messages.length, 2);

    assert.ok(
      messages.some(
        (message) =>
          message.success === false &&
          message.error.code === "DUPLICATE_REQUEST_ID",
      ),
    );
  });

  it("should reject invalid requests", async () => {
    const invalid = JSON.stringify({
      version: 1,
      kind: "request",
      id: "invalid-001",
      method: "runtime.ping",
      unexpected: true,
    }) + "\n";

    const { messages } = await execute(
      Readable.from([invalid]),
    );

    assert.equal(messages.length, 1);
    assert.equal(messages[0].success, false);

    assert.equal(
      messages[0].error.code,
      "INVALID_REQUEST",
    );
  });

  it("should reject oversized lines", async () => {
    const { messages, logs } = await execute(
      Readable.from([
        "x".repeat(100) + "\n",
      ]),
      undefined,
      {
        maxLineBytes: 32,
      },
    );

    assert.equal(messages.length, 0);

    assert.ok(
      logs.some((log) => log.includes("oversized")),
    );
  });

  it("should cancel an active request", async () => {
    let markStarted!: () => void;

    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    async function* input() {
      yield request("work-001", "runtime.hold");

      await started;

      yield request("cancel-001", "runtime.cancel", {
        targetRequestId: "work-001",
      });
    }

    const { messages } = await execute(
      Readable.from(input()),
      (registry) => {
        registry.register("runtime.hold", () => {
          markStarted();

          return new Promise<Record<string, unknown>>(
            () => {},
          );
        });
      },
    );

    const cancelledRequest = messages.find(
      (message) => message.id === "work-001",
    );

    const cancelResponse = messages.find(
      (message) => message.id === "cancel-001",
    );

    assert.equal(cancelledRequest.success, false);

    assert.equal(
      cancelledRequest.error.code,
      "REQUEST_CANCELLED",
    );

    assert.equal(cancelResponse.success, true);
    assert.equal(cancelResponse.result.cancelled, true);
  });
});
