
/**
 * Pi Studio Runtime 统一错误体系
 *
 * 所有 Runtime 业务错误都应该使用 RuntimeApplicationError。
 * 未知异常由上层统一转换为 INTERNAL_ERROR。
 */

export interface RuntimeErrorOptions {
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export interface RuntimeErrorPayload {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export class RuntimeApplicationError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: RuntimeErrorOptions = {},
  ) {
    super(message);

    this.name = "RuntimeApplicationError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * 将任意异常转换成统一错误结构。
 *
 * 不直接向外暴露未知异常的内部信息，
 * 避免泄露文件路径、密钥或内部实现细节。
 */
export function normalizeRuntimeError(
  error: unknown,
): RuntimeErrorPayload {
  if (error instanceof RuntimeApplicationError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details !== undefined
        ? { details: error.details }
        : {}),
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message: "An unexpected runtime error occurred.",
    retryable: false,
  };
}
