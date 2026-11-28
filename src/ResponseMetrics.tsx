type MetricMessage = { durationMs?: unknown; usage?: { output?: unknown } };

function latestAssistant(messages: unknown): MetricMessage | null {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || typeof message !== "object" || message.role !== "assistant") continue;
    if (message.stopReason !== "stop" && message.stopReason !== "length") return null;
    return { durationMs: message.durationMs, usage: message.usage };
  }
  return null;
}

export default function ResponseMetrics({ messages }: { messages: unknown }) {
  const message = latestAssistant(messages);
  const duration = message?.durationMs;
  const output = message?.usage?.output;
  const hasDuration = typeof duration === "number" && Number.isFinite(duration) && duration >= 0 && duration <= Number.MAX_SAFE_INTEGER;
  const hasOutput = typeof output === "number" && Number.isSafeInteger(output) && output > 0;
  if (!hasDuration && !hasOutput) return null;
  const time = !hasDuration ? "" : duration < 1 ? "<1 毫秒" : duration < 1000 ? `${Math.round(duration)} 毫秒` :
    `${(duration / 1000).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 秒`;
  return <p className="response-metrics" aria-label="本次请求统计">
    {hasDuration && <span title="原生请求耗时，包含等待和推理，不是首字延迟。">耗时 {time}</span>}
    {hasOutput && <span title="服务商报告的输出 token，已包含推理 token（如有）。">输出 {output.toLocaleString("zh-CN")} tokens</span>}
  </p>;
}
