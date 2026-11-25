import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type ModelUsage = {
  model: string;
  inputTokens: number | null; outputTokens: number | null;
  cacheReadTokens: number | null; cacheWriteTokens: number | null;
  reasoningTokens: number | null; totalTokens: number | null; costUsd: number | null;
};
type UsagePage = { items: ModelUsage[]; nextAfterModel: string | null };
const count = (value: number | null) => value === null ? "—" : value.toLocaleString("zh-CN");
function cost(value: number | null) {
  if (value === null) return "未提供估算";
  if (value < 0.000001) return "< $0.000001";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 6, maximumFractionDigits: 6 })}`;
}

export default function ConversationUsage({ conversationId, revision }: { conversationId: number; revision: number }) {
  const [items, setItems] = useState<ModelUsage[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    let active = true;
    generation.current += 1;
    setLoading(true); setLoadingMore(false); setItems([]); setCursor(null); setError("");
    void invoke<UsagePage>("conversation_usage", { conversationId, limit: 20 }).then((page) => {
      if (active) { setItems(page.items); setCursor(page.nextAfterModel); }
    }).catch(() => { if (active) setError("用量读取失败，请刷新用量重试。"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; generation.current += 1; };
  }, [conversationId, revision, refresh]);

  async function more() {
    if (!cursor || loading || loadingMore) return;
    const epoch = generation.current;
    setLoadingMore(true); setError("");
    try {
      const page = await invoke<UsagePage>("conversation_usage", { conversationId, limit: 20, afterModel: cursor });
      if (epoch !== generation.current) return;
      setItems((previous) => [...previous, ...page.items.filter((item) => !previous.some((known) => known.model === item.model))]);
      setCursor(page.nextAfterModel);
    } catch { if (epoch === generation.current) setError("更多用量读取失败，请重试。"); }
    finally { if (epoch === generation.current) setLoadingMore(false); }
  }
  return <section className="conversation-usage" aria-label="会话用量">
    <div className="transcript-heading"><strong>本会话累计用量</strong>
      <button type="button" disabled={loading || loadingMore} onClick={() => setRefresh((value) => value + 1)}>刷新用量</button>
    </div>
    <p className="muted">按模型统计已记录的尝试，包含失败和停止；生成中的用量可能尚未计入。推理 token 已包含在输出中。</p>
    {error && <p className="error" role="alert">{error}</p>}
    {loading ? <p className="muted">正在读取用量...</p> : items.length === 0 ? <p className="muted">暂无已记录的模型用量。</p> :
      <div className="usage-table-scroll"><table className="usage-table">
        <thead><tr><th>模型</th><th>输入</th><th>输出</th><th>总 token</th><th>参考费用（USD）</th></tr></thead>
        <tbody>{items.map((item) => <tr key={item.model}>
          <td>{item.model}<small>缓存读取 {count(item.cacheReadTokens)} · 写入 {count(item.cacheWriteTokens)}{item.reasoningTokens !== null ? ` · 推理 ${count(item.reasoningTokens)}` : ""}</small></td>
          <td>{count(item.inputTokens)}</td><td>{count(item.outputTokens)}</td><td>{count(item.totalTokens)}</td><td>{cost(item.costUsd)}</td>
        </tr>)}</tbody>
      </table></div>}
    {cursor && <button className="conversation-more" type="button" disabled={loading || loadingMore} onClick={() => void more()}>{loadingMore ? "加载用量中..." : "加载更多模型用量"}</button>}
    <p className="muted">费用仅供参考，以服务商账单为准；未提供估算不代表免费。服务商未上报或中断未保存的数据可能缺失，记录为 0 不代表实际消耗为 0。</p>
  </section>;
}
