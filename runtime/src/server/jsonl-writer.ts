
import type { Writable } from "node:stream";

/**
 * JSONL 单写入者。
 *
 * 保证：
 * - 消息写入不交错
 * - 每条消息独占一行
 * - 处理 Writable 背压
 * - 限制待写入队列长度
 */
export class JsonlWriter {
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;
  private failed: Error | null = null;

  constructor(
    private readonly output: Writable,
    private readonly maxQueued = 512,
  ) {
    if (!Number.isSafeInteger(maxQueued) || maxQueued <= 0) {
      throw new Error("Invalid maxQueued");
    }

    output.on("error", (error: Error) => {
      this.failed = error;
    });
  }

  send(message: unknown): Promise<void> {
    if (this.failed) {
      return Promise.reject(this.failed);
    }

    if (this.queued >= this.maxQueued) {
      return Promise.reject(
        new Error("IPC_OUTBOUND_QUEUE_FULL"),
      );
    }

    let serialized: string;

    try {
      const json = JSON.stringify(message);

      if (typeof json !== "string") {
        throw new Error("Invalid JSON message");
      }

      serialized = json + "\n";
    } catch (error) {
      return Promise.reject(error);
    }

    this.queued++;

    const operation = this.tail.then(() => {
      if (this.failed) {
        throw this.failed;
      }

      return this.writeLine(serialized);
    });

    this.tail = operation.catch(() => {});

    return operation.finally(() => {
      this.queued--;
    });
  }

  async flush(): Promise<void> {
    await this.tail;
  }

  private writeLine(line: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.output.destroyed || this.output.writableEnded) {
        reject(new Error("IPC output is closed"));
        return;
      }

      let writeCompleted = false;
      let drainCompleted = false;
      let settled = false;

      const cleanup = () => {
        this.output.off("drain", onDrain);
        this.output.off("error", onError);
        this.output.off("close", onClose);
      };

      const fail = (error: Error) => {
        if (settled) return;

        settled = true;
        this.failed = error;

        cleanup();
        reject(error);
      };

      const complete = () => {
        if (
          settled ||
          !writeCompleted ||
          !drainCompleted
        ) {
          return;
        }

        settled = true;
        cleanup();
        resolve();
      };

      const onDrain = () => {
        drainCompleted = true;
        complete();
      };

      const onError = (error: Error) => {
        fail(error);
      };

      const onClose = () => {
        fail(new Error("IPC output closed unexpectedly"));
      };

      this.output.once("error", onError);
      this.output.once("close", onClose);

      try {
        const accepted = this.output.write(
          line,
          (error?: Error | null) => {
            if (error) {
              fail(error);
              return;
            }

            writeCompleted = true;
            complete();
          },
        );

        if (accepted) {
          drainCompleted = true;
          complete();
        } else {
          this.output.once("drain", onDrain);
        }
      } catch (error) {
        fail(
          error instanceof Error
            ? error
            : new Error(String(error)),
        );
      }
    });
  }
}
