
import type { RuntimeRequest } from "../protocol/messages.js";

/**
 * Handler 执行上下文。
 *
 * 每个请求拥有独立的执行上下文。
 */
export interface RuntimeHandlerContext {
  /** 当前请求 ID */
  readonly requestId: string;

  /** 请求取消信号 */
  readonly signal: AbortSignal;

  /** 请求接收时间 */
  readonly receivedAt: number;

  /** 向 Runtime 外部发布事件 */
  emit(
    event: string,
    data: Record<string, unknown>,
  ): void;
}

/**
 * Runtime Handler 标准接口。
 */
export type RuntimeHandler = (
  request: RuntimeRequest,
  context: RuntimeHandlerContext,
) => Promise<Record<string, unknown>> | Record<string, unknown>;
