
/**
 * JSONL 输入分帧器。
 *
 * 职责：
 * 1. 处理跨 Buffer 的消息
 * 2. 识别 LF / CRLF
 * 3. 限制单条消息大小
 * 4. 丢弃超限消息，避免无限缓存
 */

export type LineFrame =
  | { kind: "line"; line: string }
  | { kind: "too_large" };

export class JsonlLineFramer {
  private chunks: Buffer[] = [];
  private size = 0;
  private discarding = false;

  constructor(
    private readonly maxLineBytes = 64 * 1024,
  ) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) {
      throw new Error("Invalid maxLineBytes");
    }
  }

  push(chunk: Buffer): LineFrame[] {
    const frames: LineFrame[] = [];
    let start = 0;

    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);

      const end =
        newline === -1 ? chunk.length : newline;

      const segment = chunk.subarray(start, end);

      if (!this.discarding) {
        if (this.size + segment.length > this.maxLineBytes) {
          this.discarding = true;
          this.chunks = [];
          this.size = 0;
        } else if (segment.length > 0) {
          this.chunks.push(segment);
          this.size += segment.length;
        }
      }

      if (newline === -1) {
        break;
      }

      frames.push(this.createFrame());
      this.reset();

      start = newline + 1;
    }

    return frames;
  }

  finish(): LineFrame | null {
    if (this.discarding) {
      this.reset();
      return { kind: "too_large" };
    }

    if (this.size === 0) {
      return null;
    }

    const frame = this.createFrame();
    this.reset();

    return frame;
  }

  private createFrame(): LineFrame {
    if (this.discarding) {
      return { kind: "too_large" };
    }

    const line = Buffer.concat(
      this.chunks,
      this.size,
    )
      .toString("utf8")
      .replace(/\r$/, "");

    return { kind: "line", line };
  }

  private reset(): void {
    this.chunks = [];
    this.size = 0;
    this.discarding = false;
  }
}
