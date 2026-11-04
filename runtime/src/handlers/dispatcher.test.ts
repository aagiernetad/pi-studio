
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RuntimeApplicationError } from "../protocol/errors.js";
import type { RuntimeRequest } from "../protocol/messages.js";

import { RuntimeHandlerRegistry } from "./registry.js";
import { RuntimeRequestDispatcher } from "./dispatcher.js";

// ==========================================
// 1. 测试辅助函数
// ==========================================

/**
 * 创建标准 Runtime Request。
 */
function createRequest(method: string): RuntimeRequest {
  return {
    version: 1,
    kind: "request",
    id: "req-001",
    method,
    params: {},
  };
}

/**
 * 创建 Handler 执行上下文。
 *
 * 每个测试可以传入独立的 AbortSignal，
 * 用于模拟请求取消和超时。
 */
function createContext(
  signal = new AbortController().signal,
) {
  return {
    requestId: "req-001",
    signal,
    receivedAt: Date.now(),

    // 测试环境暂时不向外发送事件
    emit: () => {},
  };
}

// ==========================================
// 2. Request Dispatcher 单元测试
// ==========================================

describe("RuntimeRequestDispatcher", () => {

  // ----------------------------------------
  // Test 1：正常请求分发
  // ----------------------------------------

  it("should dispatch a valid request", async () => {
    const registry = new RuntimeHandlerRegistry();

    registry.register("runtime.ping", () => ({
      message: "pong",
    }));

    const dispatcher = new RuntimeRequestDispatcher(registry);

    const response = await dispatcher.dispatch(
      createRequest("runtime.ping"),
      createContext(),
    );

    assert.equal(response.kind, "response");
    assert.equal(response.success, true);

    if (response.success) {
      assert.equal(response.result.message, "pong");
    }
  });

  // ----------------------------------------
  // Test 2：不存在的 Handler
  // ----------------------------------------

  it("should return UNKNOWN_METHOD for unknown methods", async () => {
    const registry = new RuntimeHandlerRegistry();

    const dispatcher = new RuntimeRequestDispatcher(registry);

    const response = await dispatcher.dispatch(
      createRequest("task.unknown"),
      createContext(),
    );

    assert.equal(response.success, false);

    if (!response.success) {
      assert.equal(response.error.code, "UNKNOWN_METHOD");
    }
  });

  // ----------------------------------------
  // Test 3：标准业务异常转换
  // ----------------------------------------

  it("should normalize application errors", async () => {
    const registry = new RuntimeHandlerRegistry();

    registry.register("runtime.ping", () => {
      throw new RuntimeApplicationError(
        "INVALID_PARAMS",
        "Invalid parameters",
      );
    });

    const dispatcher = new RuntimeRequestDispatcher(registry);

    const response = await dispatcher.dispatch(
      createRequest("runtime.ping"),
      createContext(),
    );

    assert.equal(response.success, false);

    if (!response.success) {
      assert.equal(response.error.code, "INVALID_PARAMS");
      assert.equal(response.error.message, "Invalid parameters");
    }
  });

  // ----------------------------------------
  // Test 4：隐藏未知内部异常
  // ----------------------------------------

  it("should hide unexpected internal errors", async () => {
    const registry = new RuntimeHandlerRegistry();

    registry.register("runtime.ping", () => {
      throw new Error("secret internal information");
    });

    const dispatcher = new RuntimeRequestDispatcher(registry);

    const response = await dispatcher.dispatch(
      createRequest("runtime.ping"),
      createContext(),
    );

    assert.equal(response.success, false);

    if (!response.success) {
      assert.equal(response.error.code, "INTERNAL_ERROR");

      assert.equal(
        response.error.message,
        "An unexpected runtime error occurred.",
      );
    }
  });

  // ----------------------------------------
  // Test 5：执行前取消请求
  // ----------------------------------------

  it("should reject already cancelled requests", async () => {
    const registry = new RuntimeHandlerRegistry();

    registry.register("runtime.ping", () => ({
      message: "pong",
    }));

    const dispatcher = new RuntimeRequestDispatcher(registry);

    const controller = new AbortController();

    // 请求开始之前就取消
    controller.abort();

    const response = await dispatcher.dispatch(
      createRequest("runtime.ping"),
      createContext(controller.signal),
    );

    assert.equal(response.success, false);

    if (!response.success) {
      assert.equal(response.error.code, "REQUEST_CANCELLED");
    }
  });

  // ----------------------------------------
  // Test 6：执行过程中取消请求（新增）
  // ----------------------------------------

  it("should cancel a running handler", async () => {
    const registry = new RuntimeHandlerRegistry();

    // 用于通知测试程序 Handler 已经开始执行
    let markStarted!: () => void;

    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    // 注册一个不会自行结束的 Handler
    registry.register("runtime.wait", () => {
      markStarted();

      // 模拟一个长期运行、暂时不会返回的异步任务
      return new Promise<Record<string, unknown>>(() => {});
    });

    const dispatcher = new RuntimeRequestDispatcher(registry);

    // 为当前请求创建独立的取消控制器
    const controller = new AbortController();

    // 开始执行请求，但不立即等待结果
    const pendingResponse = dispatcher.dispatch(
      createRequest("runtime.wait"),
      createContext(controller.signal),
    );

    // 确保 Handler 已经真正开始执行
    await started;

    // 模拟运行过程中发生超时
    controller.abort(
      new RuntimeApplicationError(
        "REQUEST_TIMEOUT",
        "Request timed out.",
      ),
    );

    // 等待 Dispatcher 返回取消结果
    const response = await pendingResponse;

    // 验证请求执行失败
    assert.equal(response.success, false);

    if (!response.success) {
      // 验证错误代码正确
      assert.equal(response.error.code, "REQUEST_TIMEOUT");

      // 验证错误信息正确
      assert.equal(response.error.message, "Request timed out.");
    }
  });

});
