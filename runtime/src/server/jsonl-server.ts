
import type { Readable, Writable } from "node:stream";

import {
  PROTOCOL_VERSION,
  RuntimeEventSchema,
  RuntimeResponseSchema,
  type RuntimeRequest,
  type RuntimeResponse,
  type RuntimeEvent,
} from "../protocol/messages.js";

import { parseRequestLine } from "../protocol/validator.js";

import { RuntimeApplicationError } from "../protocol/errors.js";

import { RuntimeRequestDispatcher } from "../handlers/dispatcher.js";

import type { RuntimeHandlerContext } from "../handlers/types.js";

import { JsonlLineFramer, type LineFrame } from "./line-framer.js";
import { JsonlWriter } from "./jsonl-writer.js";

// ==========================================
// 1. Server 配置
// ==========================================

export interface JsonlServerOptions {
  input?: Readable;
  output?: Writable;

  maxConcurrentRequests?: number;
  requestTimeoutMs?: number;
  maxLineBytes?: number;
  shutdownGraceMs?: number;

  log?: (message: string) => void;
}

interface ActiveRequest {
  controller: AbortController;
  done: Promise<void>;
}

// ==========================================
// 2. 有超时上限的异步等待
// ==========================================

function waitAtMost(
  operation: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);

    void operation.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

// ==========================================
// 3. JSONL Server
// ==========================================

export class JsonlServer {
  private readonly input: Readable;
  private readonly writer: JsonlWriter;
  private readonly framer: JsonlLineFramer;

  private readonly active = new Map<string, ActiveRequest>();
  private readonly recentIds = new Set<string>();

  private readonly maxConcurrentRequests: number;
  private readonly requestTimeoutMs: number;
  private readonly shutdownGraceMs: number;

  private readonly log: (message: string) => void;

  private sequence = 0;
  private started = false;
  private stopping = false;

  constructor(
    private readonly dispatcher: RuntimeRequestDispatcher,
    options: JsonlServerOptions = {},
  ) {
    this.input = options.input ?? process.stdin;

    this.writer = new JsonlWriter(
      options.output ?? process.stdout,
    );

    this.framer = new JsonlLineFramer(
      options.maxLineBytes ?? 64 * 1024,
    );

    this.maxConcurrentRequests =
      options.maxConcurrentRequests ?? 8;

    this.requestTimeoutMs =
      options.requestTimeoutMs ?? 15_000;

    this.shutdownGraceMs =
      options.shutdownGraceMs ?? 3_000;

    this.log =
      options.log ??
      ((message) => {
        process.stderr.write(
          `[runtime] ${message}\n`,
        );
      });

    for (const [name, value] of [
      ["maxConcurrentRequests", this.maxConcurrentRequests],
      ["requestTimeoutMs", this.requestTimeoutMs],
      ["shutdownGraceMs", this.shutdownGraceMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Invalid ${name}`);
      }
    }
  }

  // ========================================
  // 4. Runtime 主循环
  // ========================================

  async run(): Promise<void> {
    if (this.started) {
      throw new Error("JSONL Server already started");
    }

    this.started = true;
    this.log("JSONL Server started");

    try {
      for await (const chunk of this.input) {
        const buffer = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk);

        const frames = this.framer.push(buffer);

        for (const frame of frames) {
          this.handleFrame(frame);
        }
      }

      const remaining = this.framer.finish();

      if (remaining) {
        this.handleFrame(remaining);
      }
    } catch (error) {
      if (!this.stopping) {
        throw error;
      }
    } finally {
      await this.shutdown();
      this.log("JSONL Server stopped");
    }
  }

  stop(): void {
    if (this.stopping) return;

    this.stopping = true;
    this.input.destroy();
  }

  // ========================================
  // 5. 消息分帧与协议校验
  // ========================================

  private handleFrame(frame: LineFrame): void {
    if (frame.kind === "too_large") {
      this.log("Rejected oversized IPC message");
      return;
    }

    const line = frame.line;

    if (!line.trim()) {
      return;
    }

    const parsed = parseRequestLine(line);

    if (!parsed.success) {
      if (parsed.requestId === null) {
        // 没有合法 ID，无法安全关联响应
        this.log(
          `Rejected request: ${parsed.error.code}`,
        );

        return;
      }

      void this.send(
        this.failure(
          parsed.requestId,
          parsed.error.code,
          parsed.error.message,
        ),
      );

      return;
    }

    this.handleRequest(parsed.request);
  }

  // ========================================
  // 6. 请求 ID 与并发控制
  // ========================================

  private handleRequest(request: RuntimeRequest): void {
    if (
      this.active.has(request.id) ||
      this.recentIds.has(request.id)
    ) {
      void this.send(
        this.failure(
          request.id,
          "DUPLICATE_REQUEST_ID",
          "Request ID has already been used.",
        ),
      );

      return;
    }

    this.rememberId(request.id);

    // 协议控制方法：不占普通 Handler 并发额度
    if (request.method === "runtime.cancel") {
      this.handleCancel(request);
      return;
    }

    if (this.active.size >= this.maxConcurrentRequests) {
      void this.send(
        this.failure(
          request.id,
          "SERVER_BUSY",
          "Runtime concurrency limit reached.",
          true,
        ),
      );

      return;
    }

    this.startRequest(request);
  }

  private rememberId(id: string): void {
    this.recentIds.add(id);

    // 只保留最近的请求 ID，限制内存占用
    if (this.recentIds.size > 4096) {
      const oldest = this.recentIds.values().next().value;

      if (oldest !== undefined) {
        this.recentIds.delete(oldest);
      }
    }
  }

  // ========================================
  // 7. 执行请求
  // ========================================

  private startRequest(request: RuntimeRequest): void {
    const controller = new AbortController();

    const timer = setTimeout(() => {
      controller.abort(
        new RuntimeApplicationError(
          "REQUEST_TIMEOUT",
          "Runtime request timed out.",
        ),
      );
    }, this.requestTimeoutMs);

    timer.unref();

    const context: RuntimeHandlerContext = {
      requestId: request.id,
      receivedAt: Date.now(),
      signal: controller.signal,

      emit: (event, data) => {
        if (controller.signal.aborted || this.stopping) {
          return;
        }

        try {
          const message = RuntimeEventSchema.parse({
            version: PROTOCOL_VERSION,
            kind: "event",
            event,
            sequence: ++this.sequence,
            data: {
              ...data,
              requestId: request.id,
            },
          });

          void this.send(message);
        } catch (error) {
          this.log(
            `Invalid event: ${String(error)}`,
          );
        }
      },
    };

    const done = (async () => {
      try {
        const response = await this.dispatcher.dispatch(
          request,
          context,
        );

        await this.send(response);
      } catch (error) {
        this.log(
          `Request execution error: ${String(error)}`,
        );
        this.stop();
      } finally {
        clearTimeout(timer);
        this.active.delete(request.id);
      }
    })();

    this.active.set(request.id, {
      controller,
      done,
    });
  }

  // ========================================
  // 8. 请求取消
  // ========================================

  private handleCancel(request: RuntimeRequest): void {
    const targetRequestId = request.params.targetRequestId;

    if (
      typeof targetRequestId !== "string" ||
      targetRequestId.length < 1 ||
      targetRequestId.length > 128 ||
      Object.keys(request.params).length !== 1
    ) {
      void this.send(
        this.failure(
          request.id,
          "INVALID_PARAMS",
          "runtime.cancel requires targetRequestId.",
        ),
      );

      return;
    }

    const activeRequest = this.active.get(targetRequestId);

    if (activeRequest) {
      activeRequest.controller.abort(
        new RuntimeApplicationError(
          "REQUEST_CANCELLED",
          "Request cancelled by caller.",
        ),
      );
    }

    void this.send(
      RuntimeResponseSchema.parse({
        version: PROTOCOL_VERSION,
        kind: "response",
        id: request.id,
        success: true,
        result: {
          targetRequestId,
          cancelled: activeRequest !== undefined,
        },
      }),
    );
  }

  // ========================================
  // 9. 统一响应写出
  // ========================================

  private failure(
    id: string,
    code: string,
    message: string,
    retryable = false,
  ): RuntimeResponse {
    return RuntimeResponseSchema.parse({
      version: PROTOCOL_VERSION,
      kind: "response",
      id,
      success: false,
      error: {
        code,
        message,
        retryable,
      },
    });
  }

  private send(
    message: RuntimeResponse | RuntimeEvent,
  ): Promise<void> {
    const operation = this.writer.send(message);

    // 观察异步写入异常，避免静默丢失响应
    void operation.catch((error) => {
      this.log(
        `IPC output failure: ${String(error)}`,
      );

      this.stop();
    });

    return operation;
  }

  // ========================================
  // 10. 优雅关闭
  // ========================================

  private async shutdown(): Promise<void> {
    const running = [...this.active.values()].map(
      (request) => request.done,
    );

    // 正常 stdin 关闭时，先等待已有请求完成
    await waitAtMost(
      Promise.allSettled(running),
      this.shutdownGraceMs,
    );

    this.stopping = true;

    // 超过宽限期仍未完成，则通知 Handler 取消
    for (const request of this.active.values()) {
      request.controller.abort(
        new RuntimeApplicationError(
          "RUNTIME_SHUTDOWN",
          "Runtime is shutting down.",
        ),
      );
    }

    await waitAtMost(
      Promise.allSettled(running),
      1_000,
    );

    // 尽可能完成已经排队的输出
    await waitAtMost(
      this.writer.flush(),
      1_000,
    );
  }
}
