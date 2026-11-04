
import { z } from "zod";

// ==========================================
// 1. 协议版本
// ==========================================

export const PROTOCOL_VERSION = 1 as const;

// 通用标识符
const IdentifierSchema = z.string().min(1).max(128);

// 消息数据必须是 JSON 对象
const DataSchema = z.record(z.string(), z.unknown());

// ==========================================
// 2. Request：请求消息
// ==========================================

export const RuntimeRequestSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),

  kind: z.literal("request"),

  id: IdentifierSchema,

  method: z.string().min(1).max(128),

  params: DataSchema.default({}),
}).strict();

export type RuntimeRequest = z.infer<
  typeof RuntimeRequestSchema
>;

// ==========================================
// 3. Response：成功响应
// ==========================================

export const RuntimeSuccessResponseSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),

  kind: z.literal("response"),

  id: IdentifierSchema,

  success: z.literal(true),

  result: DataSchema,
}).strict();

// ==========================================
// 4. Response：失败响应
// ==========================================

export const RuntimeFailureResponseSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),

  kind: z.literal("response"),

  id: IdentifierSchema,

  success: z.literal(false),

  error: z.object({
    code: z.string(),

    message: z.string(),

    retryable: z.boolean(),

    details: DataSchema.optional(),
  }).strict(),
}).strict();

// 统一响应类型
export const RuntimeResponseSchema = z.discriminatedUnion(
  "success",
  [
    RuntimeSuccessResponseSchema,
    RuntimeFailureResponseSchema,
  ]
);

export type RuntimeResponse = z.infer<
  typeof RuntimeResponseSchema
>;

// ==========================================
// 5. Event：事件消息
// ==========================================

export const RuntimeEventSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),

  kind: z.literal("event"),

  event: z.string().min(1).max(128),

  sequence: z.number().int().nonnegative(),

  data: DataSchema,
}).strict();

export type RuntimeEvent = z.infer<
  typeof RuntimeEventSchema
>;

// ==========================================
// 6. Node.js 发出的所有消息
// ==========================================

export const RuntimeOutboundMessageSchema = z.union([
  RuntimeResponseSchema,
  RuntimeEventSchema,
]);

export type RuntimeOutboundMessage = z.infer<
  typeof RuntimeOutboundMessageSchema
>;
