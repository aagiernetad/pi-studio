
import {
  RuntimeResponseSchema,
  type RuntimeRequest,
  type RuntimeResponse,
} from "../protocol/messages.js";

import {
  RuntimeApplicationError,
  normalizeRuntimeError,
} from "../protocol/errors.js";

import { RuntimeHandlerRegistry } from "./registry.js";

import type { RuntimeHandlerContext } from "./types.js";

/**
 * 将 AbortSignal 转换为统一 Runtime 错误。
 */
function getAbortError(
  signal: AbortSignal,
): RuntimeApplicationError {
  if (signal.reason instanceof RuntimeApplicationError) {
    return signal.reason;
  }

  return new RuntimeApplicationError(
    "REQUEST_CANCELLED",
    "Request was cancelled.",
  );
}

/**
 * 让异步 Handler 支持取消等待。
 *
 * 注意：
 * AbortSignal 是协作式取消机制。
 * Handler 自身也必须检查 signal，才能真正停止底层工作。
 */
function awaitWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(getAbortError(signal));
  }

  let abortHandler: (() => void) | undefined;

  const abortPromise = new Promise<never>((_, reject) => {
    abortHandler = () => {
      reject(getAbortError(signal));
    };

    signal.addEventListener(
      "abort",
      abortHandler,
      { once: true },
    );
  });

  return Promise.race([
    operation,
    abortPromise,
  ]).finally(() => {
    if (abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
  });
}

/**
 * Runtime 请求分发器。
 */
export class RuntimeRequestDispatcher {
  constructor(
    private readonly registry: RuntimeHandlerRegistry,
  ) {}

  async dispatch(
    request: RuntimeRequest,
    context: RuntimeHandlerContext,
  ): Promise<RuntimeResponse> {
    try {
      // 1. 检查取消状态
      if (context.signal.aborted) {
        throw getAbortError(context.signal);
      }

      // 2. 查找 Handler
      const handler = this.registry.resolve(request.method);

      if (!handler) {
        throw new RuntimeApplicationError(
          "UNKNOWN_METHOD",
          `Unknown runtime method: ${request.method}`,
        );
      }

      // 3. 执行 Handler
      // Promise.resolve().then 可以统一处理同步和异步异常
      const handlerPromise = Promise.resolve().then(() => {
        if (context.signal.aborted) {
          throw getAbortError(context.signal);
        }

        return handler(request, context);
      });

      const result = await awaitWithAbort(
        handlerPromise,
        context.signal,
      );

      // 4. 校验 Handler 返回值
      if (
        typeof result !== "object" ||
        result === null ||
        Array.isArray(result)
      ) {
        throw new RuntimeApplicationError(
          "INVALID_HANDLER_RESULT",
          "Handler must return a JSON object.",
        );
      }

      // 5. 确保结果可以安全序列化为 JSON
      let normalizedResult: Record<string, unknown>;

      try {
        const serialized = JSON.stringify(result);

        if (serialized === undefined) {
          throw new Error("Result is not JSON serializable");
        }

        normalizedResult = JSON.parse(serialized);
      } catch {
        throw new RuntimeApplicationError(
          "INVALID_HANDLER_RESULT",
          "Handler returned a non-serializable result.",
        );
      }

      // 6. 返回成功响应
      return RuntimeResponseSchema.parse({
        version: 1,
        kind: "response",
        id: request.id,
        success: true,
        result: normalizedResult,
      });
    } catch (error) {
      // 7. 统一错误转换
      const normalizedError = normalizeRuntimeError(error);

      return RuntimeResponseSchema.parse({
        version: 1,
        kind: "response",
        id: request.id,
        success: false,
        error: normalizedError,
      });
    }
  }
}
