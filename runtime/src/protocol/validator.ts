
import {
  PROTOCOL_VERSION,
  RuntimeRequestSchema,
  type RuntimeRequest,
} from "./messages.js";

import { RuntimeApplicationError } from "./errors.js";

export type RequestParseResult =
  | {
      success: true;
      request: RuntimeRequest;
    }
  | {
      success: false;
      requestId: string | null;
      error: RuntimeApplicationError;
    };

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

/**
 * 从不可信的 JSONL 输入中提取请求 ID。
 *
 * 只有符合协议标识符基本约束的 ID 才能用于响应关联。
 */
function extractRequestId(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = value.id;

  if (
    typeof id !== "string" ||
    id.length < 1 ||
    id.length > 128
  ) {
    return null;
  }

  return id;
}

/**
 * 解析并校验一行 JSONL 请求。
 *
 * 处理流程：
 * 1. JSON 解析
 * 2. 提取请求 ID
 * 3. 检查协议版本
 * 4. Zod Schema 校验
 * 5. 返回标准化结果
 */
export function parseRequestLine(
  line: string,
): RequestParseResult {
  let raw: unknown;

  // 第一层：JSON 语法校验
  try {
    raw = JSON.parse(line);
  } catch {
    return {
      success: false,
      requestId: null,
      error: new RuntimeApplicationError(
        "INVALID_JSON",
        "Request line is not valid JSON.",
      ),
    };
  }

  const requestId = extractRequestId(raw);

  // 第二层：协议版本检查
  if (
    isRecord(raw) &&
    raw.version !== undefined &&
    raw.version !== PROTOCOL_VERSION
  ) {
    return {
      success: false,
      requestId,
      error: new RuntimeApplicationError(
        "UNSUPPORTED_PROTOCOL_VERSION",
        `Unsupported protocol version: ${String(raw.version)}`,
        {
          details: {
            expectedVersion: PROTOCOL_VERSION,
            receivedVersion: raw.version,
          },
        },
      ),
    };
  }

  // 第三层：Schema 校验
  const result = RuntimeRequestSchema.safeParse(raw);

  if (!result.success) {
    return {
      success: false,
      requestId,
      error: new RuntimeApplicationError(
        "INVALID_REQUEST",
        "Request does not match the IPC protocol schema.",
        {
          details: {
            issues: result.error.issues.map((issue) => ({
              path: issue.path.map(String).join("."),
              message: issue.message,
              code: issue.code,
            })),
          },
        },
      ),
    };
  }

  return {
    success: true,
    request: result.data,
  };
}
