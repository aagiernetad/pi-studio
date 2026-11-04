
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RuntimeHandlerRegistry } from "./registry.js";

describe("RuntimeHandlerRegistry", () => {
  it("should register and resolve a handler", () => {
    const registry = new RuntimeHandlerRegistry();

    const handler = () => ({ message: "pong" });

    registry.register("runtime.ping", handler);

    assert.equal(registry.resolve("runtime.ping"), handler);
    assert.equal(registry.has("runtime.ping"), true);
  });

  it("should reject duplicate registration", () => {
    const registry = new RuntimeHandlerRegistry();

    registry.register("runtime.ping", () => ({}));

    assert.throws(
      () => registry.register("runtime.ping", () => ({})),
      /already registered/,
    );
  });

  it("should reject invalid method names", () => {
    const registry = new RuntimeHandlerRegistry();

    assert.throws(
      () => registry.register("Runtime Ping", () => ({})),
      /Invalid handler method/,
    );
  });

  it("should return sorted method names", () => {
    const registry = new RuntimeHandlerRegistry();

    registry.register("worker.spawn", () => ({}));
    registry.register("runtime.ping", () => ({}));
    registry.register("task.submit", () => ({}));

    assert.deepEqual(registry.listMethods(), [
      "runtime.ping",
      "task.submit",
      "worker.spawn",
    ]);
  });

  it("should unregister a handler", () => {
    const registry = new RuntimeHandlerRegistry();

    registry.register("runtime.ping", () => ({}));

    assert.equal(registry.unregister("runtime.ping"), true);
    assert.equal(registry.has("runtime.ping"), false);
  });
});
