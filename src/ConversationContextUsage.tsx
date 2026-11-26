import { useEffect, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";

type ContextUsage = {
  conversationId: number; latestEntryId: number | null;
  state: "empty" | "unreported" | "reported";
  lastRequest: {
    providerId: string; modelId: string; inputTokens: number; outputTokens: number | null;
    cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number | null; contextWindow: number | null;
  } | null;
};

export default function ConversationContextUsage({ conversationId, latestEntryId, contextReset, catalogRevision, disabled, onReset }: {
  conversationId: number; latestEntryId: number | null; contextReset: boolean; catalogRevision: number;
  disabled: boolean; onReset: () => void;
}) {
  const [data, setData] = useState<ContextUsage | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [position, setPosition] = useState({ left: 12, bottom: 12, maxHeight: 420 });
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let active = true;
    setData(null); setError(false);
    void invoke<ContextUsage>("conversation_context_usage", { conversationId }).then(result => {
      if (!active) return;
      if (result.conversationId !== conversationId || (latestEntryId !== null && (result.latestEntryId === null || result.latestEntryId < latestEntryId))) {
        setError(true); return;
      }
      setData(result);
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [conversationId, latestEntryId, contextReset, catalogRevision, revision]);
  useEffect(() => {
    const close = () => dialog.current?.close();
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, []);
  const request = contextReset ? null : data?.lastRequest;
  const capacity = request?.contextWindow;
  const ratio = request && capacity ? request.inputTokens / capacity : null;
  const percentage = ratio === null ? null : Math.round(ratio * 1000) / 10;
  const percentageLabel = ratio !== null && ratio > 0 && ratio < .001 ? "<0.1%" : `${percentage}%`;
  const empty = contextReset || data?.state === "empty";
  const label = error ? "用量读取失败" : empty ? "新上下文" : data ? (percentage === null ? "上次输入 —" : `上次输入 ${percentageLabel}`) : "读取用量...";
  function open() {
    if (!trigger.current || !dialog.current) return;
    const box = trigger.current.getBoundingClientRect();
    const above = box.top >= 290;
    setPosition({ left: Math.max(12, Math.min(box.right - 310, innerWidth - 322)),
      bottom: above ? innerHeight - box.top + 8 : 12,
      maxHeight: Math.min(420, above ? box.top - 24 : innerHeight - 24) });
    dialog.current.showModal();
  }
  const number = (value: number | null) => value === null ? "未报告" : value.toLocaleString();
  return <div className="context-usage">
    <button ref={trigger} type="button" className="context-usage-trigger" aria-label="查看上下文用量" aria-haspopup="dialog"
      title="最近一次已完成请求的输入占比，不包含未发送草稿" onClick={open} data-warning={ratio !== null && ratio >= .8}
      style={{ "--context-fill": `${Math.min(100, Math.max(0, (ratio ?? 0) * 100))}%` } as CSSProperties}>
      <span className="context-vial" aria-hidden="true"><i /></span><span>{label}</span>
    </button>
    <dialog ref={dialog} className="context-usage-dialog" aria-label="上下文用量" style={position}
      onClose={() => trigger.current?.focus()}
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dialog.current?.close(); } }}
      onClick={event => {
        if (event.target !== event.currentTarget) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.current?.close();
      }}>
      <header><strong>上次请求</strong><button type="button" aria-label="关闭上下文用量" onClick={() => dialog.current?.close()}>×</button></header>
      {error ? <p role="alert" className="error">无法读取用量，请重试。</p> : empty ? <p role="status">当前上下文还没有请求用量。</p> : !data ? <p role="status">正在读取...</p> : !request ? <p role="status">服务商未报告有效输入用量。</p> : <>
        <p className="context-model">{request.providerId} / {request.modelId}</p>
        <dl>
          <div><dt>输入</dt><dd>{number(request.inputTokens)} tokens</dd></div>
          <div><dt>模型目录窗口</dt><dd>{capacity ? number(capacity) + " tokens" : "目录不可用"}</dd></div>
          <div><dt>输出</dt><dd>{number(request.outputTokens)}</dd></div>
          <div><dt>缓存读取</dt><dd>{number(request.cacheReadTokens)}</dd></div>
          <div><dt>缓存写入</dt><dd>{number(request.cacheWriteTokens)}</dd></div>
          {request.reasoningTokens !== null && <div><dt>其中推理</dt><dd>{number(request.reasoningTokens)}</dd></div>}
        </dl>
        {ratio !== null && ratio >= .8 && <p className="context-warning">上次输入已接近该模型目录窗口，可开始新上下文。</p>}
      </>}
      <p className="muted context-basis">输入包含缓存。此处显示上次已完成请求，不代表下一次请求；不包含未发送草稿。切换模型不会改写上次记录。</p>
      <footer><button type="button" onClick={() => setRevision(value => value + 1)}>刷新用量</button>
        <button type="button" disabled={disabled} onClick={() => { dialog.current?.close(); onReset(); }}>开始新上下文</button></footer>
    </dialog>
  </div>;
}
