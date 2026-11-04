
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RuntimeRequestSchema,
  RuntimeResponseSchema,
  RuntimeEventSchema,
} from "./messages.js";

describe("IPC Protocol V1", () => {
  describe("Request", () => {
    it("should accept a valid request", () => {
      const result = RuntimeRequestSchema.safeParse({
        version: 1,
        kind: "request",
        id: "req-001",
        method: "runtime.ping",
        params: {
          message: "Hello Pi Studio",
        },
      });

      assert.equal(result.success, true);
    });

    it("should provide default params", () => {
      const result = RuntimeRequestSchema.parse({
        version: 1,
        kind: "request",
        id: "req-002",
        method: "runtime.ping",
      });

      assert.deepEqual(result.params, {});
    });

    it("should reject unsupported protocol versions", () => {
      const result = RuntimeRequestSchema.safeParse({
        version: 2,
        kind: "request",
        id: "req-003",
        method: "runtime.ping",
        params: {},
      });

      assert.equal(result.success, false);
    });

    it("should reject unknown fields", () => {
      const result = RuntimeRequestSchema.safeParse({
        version: 1,
        kind: "request",
        id: "req-004",
        method: "runtime.ping",
        params: {},
        unexpected: true,
      });

      assert.equal(result.success, false);
    });
  });

  describe("Response", () => {
    it("should accept a successful response", () => {
      const result = RuntimeResponseSchema.safeParse({
        version: 1,
        kind: "response",
        id: "req-001",
        success: true,
        result: {
          message: "Pong",
        },
      });

      assert.equal(result.success, true);
    });

    it("should accept a failed response", () => {
      const result = RuntimeResponseSchema.safeParse({
        version: 1,
        kind: "response",
        id: "req-002",
        success: false,
        error: {
          code: "UNKNOWN_METHOD",
          message: "Unknown method",
          retryable: false,
        },
      });

      assert.equal(result.success, true);
    });
  });

  describe("Event", () => {
    it("should accept a valid runtime event", () => {
      const result = RuntimeEventSchema.safeParse({
        version: 1,
        kind: "event",
        event: "task.progress",
        sequence: 1,
        data: {
          taskId: "task-001",
          progress: 30,
        },
      });

      assert.equal(result.success, true);
    });

    it("should reject negative event sequence", () => {
      const result = RuntimeEventSchema.safeParse({
        version: 1,
        kind: "event",
        event: "task.progress",
        sequence: -1,
        data: {},
      });

      assert.equal(result.success, false);
    });
  });
});
