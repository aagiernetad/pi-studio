import { useEffect, useRef, useState, type CSSProperties } from "react";
import StudioIcon from "./StudioIcon";
import { thinkingLabels, type ThinkingLevel } from "./thinking";

type Props = {
  providers: { id: string; name: string }[];
  models: { id: string; name: string; api: string; contextWindow?: number; maxTokens?: number }[];
  providerId: string; modelId: string; disabled: boolean; loading: boolean;
  supported: (api: string) => boolean;
  thinkingLevels: ThinkingLevel[]; thinkingLevel: ThinkingLevel; onThinking: (level: ThinkingLevel) => void;
  onProvider: (id: string) => void; onModel: (id: string) => void; onRefresh: () => void;
};

function ModelGlyph({ level }: { level: ThinkingLevel }) {
  return <span className="model-glyph" data-level={level} aria-hidden="true">
    <svg viewBox="0 0 32 32" focusable="false">
      <g className="model-orbit"><ellipse cx="16" cy="16" rx="14" ry="6" transform="rotate(-30 16 16)" />
        <circle cx="28" cy="10" r="1.7" /><circle cx="4" cy="22" r="1.2" /></g>
      <path className="model-star" d="M16 5 19 12 26 16 19 19 16 27 12 19 5 16 12 12Z" />
      <circle className="model-core" cx="16" cy="16" r="2.4" />
    </svg>
  </span>;
}

export default function ConversationModelPicker({ providers, models, providerId, modelId, disabled, loading, supported, thinkingLevels, thinkingLevel, onThinking, onProvider, onModel, onRefresh }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [position, setPosition] = useState({ left: 16, bottom: 16, maxHeight: 480 });
  const selected = models.find(model => model.id === modelId);
  const visible = models.filter(model => (model.name + " " + model.id).toLowerCase().includes(query.toLowerCase().trim()));
  const glyphKey = `${providerId}/${modelId}/${thinkingLevel}`;
  const thinkingIndex = thinkingLevels.indexOf(thinkingLevel);
  const thinkingPosition = thinkingLevels.length > 1 ? thinkingIndex / (thinkingLevels.length - 1) : 0;
  useEffect(() => { if (disabled && dialog.current?.open) dialog.current.close(); }, [disabled]);
  useEffect(() => { setQuery(""); }, [providerId]);
  useEffect(() => {
    const close = () => { if (dialog.current?.open) dialog.current.close(); };
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, []);
  function open() {
    if (disabled || !dialog.current || !trigger.current) return;
    const box = trigger.current.getBoundingClientRect();
    const fitsAbove = box.top >= 270;
    setPosition({ left: Math.max(12, Math.min(box.left, window.innerWidth - 360)),
      bottom: fitsAbove ? window.innerHeight - box.top + 8 : 12,
      maxHeight: Math.min(480, fitsAbove ? box.top - 24 : window.innerHeight - 24) });
    setQuery("");
    dialog.current.showModal();
    setExpanded(true);
  }
  return <div className="model-picker">
    <button ref={trigger} type="button" className="model-picker-trigger" disabled={disabled} onClick={open}
      aria-label="选择模型" aria-haspopup="dialog" aria-expanded={expanded} data-level={thinkingLevel}
      onPointerMove={event => {
        if (disabled || event.pointerType === "touch") return;
        const box = event.currentTarget.getBoundingClientRect();
        event.currentTarget.style.setProperty("--reflect-x", `${event.clientX - box.left}px`);
        event.currentTarget.style.setProperty("--reflect-y", `${event.clientY - box.top}px`);
      }} onPointerLeave={event => {
        event.currentTarget.style.removeProperty("--reflect-x"); event.currentTarget.style.removeProperty("--reflect-y");
      }}>
      <ModelGlyph key={glyphKey} level={thinkingLevel} /><span className="model-picker-name">{selected?.name || (loading ? "读取模型..." : "选择模型")}</span>
      {thinkingLevel !== "off" && <span className="model-effort" title={`推理强度：${thinkingLabels[thinkingLevel]}`}>{thinkingLabels[thinkingLevel]}</span>}<StudioIcon name="chevron" />
    </button>
    <dialog ref={dialog} className="model-picker-dialog" aria-label="模型选择" style={position}
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setQuery(""); dialog.current?.close(); trigger.current?.focus(); } }}
      onCancel={() => setQuery("")} onClose={() => { setExpanded(false); setQuery(""); if (!disabled) trigger.current?.focus(); }} onClick={event => {
        if (event.target !== event.currentTarget) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) event.currentTarget.close();
      }}>
      <header><strong>模型</strong><button type="button" aria-label="关闭模型菜单" onClick={() => dialog.current?.close()}>×</button></header>
      <label className="provider-field"><span>服务商</span>
        <select aria-label="对话服务商" value={providerId} disabled={disabled || providers.length === 0} onChange={event => onProvider(event.target.value)}>
          {providers.map(provider => <option value={provider.id} key={provider.id}>{provider.name}</option>)}
        </select>
      </label>
      <input type="search" aria-label="搜索模型" placeholder="搜索模型..." autoFocus value={query} onChange={event => setQuery(event.target.value)} />
      <label className="provider-field model-results"><span className="sr-only">对话模型</span>
        <select aria-label="对话模型" size={6} value={modelId} disabled={disabled || loading}
          onChange={event => { onModel(event.target.value); if (event.target.value) dialog.current?.close(); }}>
          <option value="">请选择可用模型</option>
          {visible.map(model => <option key={model.id} value={model.id} disabled={!supported(model.api)}>{model.name}{model.name !== model.id ? " · " + model.id : ""}{supported(model.api) ? "" : "（暂不支持）"}</option>)}
        </select>
      </label>
      {query && !visible.length && <p className="muted" role="status">没有匹配模型。</p>}
      {selected && supported(selected.api) && thinkingLevels.some(level => level !== "off") && <div className="thinking-control" data-level={thinkingLevel}
        style={{ "--thinking-position": thinkingPosition } as CSSProperties}>
        <div className="thinking-heading"><span>推理强度</span><output key={glyphKey}><ModelGlyph level={thinkingLevel} />{thinkingLabels[thinkingLevel]}</output></div>
        {thinkingLevels.length > 1 && <div className="thinking-track">
          <span className="thinking-energy" aria-hidden="true" />
          <span className="thinking-stops" aria-hidden="true">{thinkingLevels.map((level, index) => <i key={level} style={{ "--stop-position": index / (thinkingLevels.length - 1) } as CSSProperties} />)}</span>
          <input type="range" aria-label="推理强度" aria-valuetext={thinkingLabels[thinkingLevel]}
            min={0} max={thinkingLevels.length - 1} step={1} value={thinkingIndex} disabled={disabled || loading}
            onChange={event => onThinking(thinkingLevels[Number(event.target.value)])} />
        </div>}
        <div className="thinking-ticks" aria-hidden="true">{thinkingLevels.map(level => <span key={level}>{thinkingLabels[level]}</span>)}</div>
      </div>}
      <footer>
        {selected?.contextWindow && <span className="muted">上下文 {selected.contextWindow.toLocaleString()}{selected.maxTokens ? " · 输出 " + selected.maxTokens.toLocaleString() : ""}</span>}
        <button type="button" disabled={disabled || loading} onClick={() => { dialog.current?.close(); onRefresh(); }}>刷新模型目录</button>
      </footer>
    </dialog>
  </div>;
}
