
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseRequestLine } from "./validator.js";

describe("Runtime Request Validator", () => {
  it("should parse a valid request", () => {
    const result = parseRequestLine(
      JSON.stringify({
        version: 1,
        kind: "request",
        id: "req-001",
        method: "runtime.ping",
        params: {},
      }),
    );

    assert.equal(result.success, true);

    if (result.success) {
      assert.equal(result.request.id, "req-001");
      assert.equal(result.request.method, "runtime.ping");
    }
  });

  it("should reject invalid JSON", () => {
    const result = parseRequestLine("{invalid json");

    assert.equal(result.success, false);

    if (!result.success) {
      assert.equal(result.requestId, null);
      assert.equal(result.error.code, "INVALID_JSON");
    }
  });

  it("should reject unsupported protocol versions", () => {
    const result = parseRequestLine(
      JSON.stringify({
        version: 2,
        kind: "request",
        id: "req-002",
        method: "runtime.ping",
        params: {},
      }),
    );

    assert.equal(result.success, false);

    if (!result.success) {
      assert.equal(
        result.error.code,
        "UNSUPPORTED_PROTOCOL_VERSION",
      );
    }
  });

  it("should reject invalid request fields", () => {
    const result = parseRequestLine(
      JSON.stringify({
        version: 1,
        kind: "request",
        id: "req-003",
        method: "runtime.ping",
        params: {},
        unexpected: true,
      }),
    );

    assert.equal(result.success, false);

    if (!result.success) {
      assert.equal(result.requestId, "req-003");
      assert.equal(result.error.code, "INVALID_REQUEST");
    }
  });

  it("should reject invalid request IDs", () => {
    const result = parseRequestLine(
      JSON.stringify({
        version: 1,
        kind: "request",
        id: "",
        method: "runtime.ping",
        params: {},
      }),
    );

    assert.equal(result.success, false);

    if (!result.success) {
      assert.equal(result.requestId, null);
    }
  });
});
