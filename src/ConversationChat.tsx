import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Provider = { id: string; name: string };
type Model = { id: string; name: string; api: string };
type Status = {
  running: boolean; latestEntryId: number | null; partialText: string;
  model: { providerId: string; modelId: string } | null; failureReason: string | null;
  canResume: boolean;
};
type Input = { conversationId: number; requestId: string; providerId: string; modelId: string; content: string };
const supported = (api: string) => ["openai-completions", "openai-responses", "anthropic-messages"].includes(api);
function message(cause: unknown): string {
  const code = typeof cause === "string" ? /^([A-Z_]+):/.exec(cause)?.[1] : "";
  const messages: Record<string, string> = {
    INVALID_PARAMS: "消息或模型参数无效。", MODEL_NOT_FOUND: "模型已不可用，请重新选择。",
    PROVIDER_NOT_CONFIGURED: "请先在服务商设置中保存 API Key。",
    CHAT_UNSUPPORTED: "当前仅支持所列文本接口的 API Key 认证。",
    CONVERSATION_BUSY: "该会话正在生成，请等待或停止后再发送。",
    CONVERSATION_NOT_FOUND: "当前会话不可用，请刷新会话列表。",
    REQUEST_ID_CONFLICT: "请求标识与原消息不一致，请刷新后检查历史。",
    CHAT_NOT_RESUMABLE: "当前会话已无待继续的回复，请检查最新历史。",
    CREDENTIAL_STORE_UNAVAILABLE: "无法读取系统凭据，请稍后重试。",
  };
  return (code && messages[code]) || "提交结果尚未确认，可重试同一请求，不会重复发送。";
}
const rejected = (cause: unknown) => typeof cause === "string" && /^(INVALID_PARAMS|MODEL_NOT_FOUND|PROVIDER_NOT_CONFIGURED|CHAT_UNSUPPORTED|CONVERSATION_BUSY|CONVERSATION_NOT_FOUND|REQUEST_ID_CONFLICT|CHAT_NOT_RESUMABLE|CREDENTIAL_STORE_UNAVAILABLE):/.test(cause);

export default function ConversationChat({ conversationId, onEntriesChanged }: {
  conversationId: number; onEntriesChanged: () => void;
}) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providerId, setProviderId] = useState("");
  const [models, setModels] = useState<Model[]>([]);
  const [modelId, setModelId] = useState("");
  const [modelsLoading, setModelsLoading] = useState(true);
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState("");
  const [catalogError, setCatalogError] = useState("");
  const [error, setError] = useState("");
  const [content, setContent] = useState("");
  const [action, setAction] = useState<"send" | "stop" | "resume" | null>(null);
  const [hasPending, setHasPending] = useState(false);
  const [hasPendingResume, setHasPendingResume] = useState(false);
  const [revision, setRevision] = useState(0);
  const mounted = useRef(false);
  const working = useRef(false);
  const pending = useRef<Input | null>(null);
  const pendingResume = useRef<{ conversationId: number; requestId: string } | null>(null);
  const savedModel = useRef<Status["model"]>(null);
  const onEntries = useRef(onEntriesChanged);
  onEntries.current = onEntriesChanged;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    let active = true;
    setCatalogError("");
    void invoke<{ items: Provider[] }>("provider_list").then((catalog) => {
      if (!active) return;
      setProviders(catalog.items);
      setProviderId((current) => catalog.items.some((item) => item.id === current) ? current :
        (catalog.items.find((item) => item.id === "deepseek")?.id ?? catalog.items[0]?.id ?? ""));
    }).catch(() => { if (active) setCatalogError("服务商目录读取失败，请刷新模型目录。"); });
    return () => { active = false; };
  }, [revision]);
  useEffect(() => {
    if (!providerId) return;
    let active = true;
    setModelsLoading(true);
    setModels([]);
    void invoke<{ items: Model[] }>("model_list", { providerId }).then((catalog) => {
      if (!active) return;
      setModels(catalog.items);
      setModelId((current) => catalog.items.some((item) => item.id === current) ? current :
        (savedModel.current?.providerId === providerId ?
          (catalog.items.some((item) => item.id === savedModel.current?.modelId) ? savedModel.current.modelId : "") :
          (catalog.items.find((item) => supported(item.api))?.id ?? "")));
    }).catch(() => { if (active) setCatalogError("模型目录读取失败，请刷新模型目录。"); })
      .finally(() => { if (active) setModelsLoading(false); });
    return () => { active = false; };
  }, [providerId, revision]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let first = true;
    let latest: number | null | undefined;
    async function poll() {
      try {
        const next = await invoke<Status>("conversation_chat_status", { conversationId });
        if (!active) return;
        setStatus(next);
        setStatusError("");
        if (first) {
          savedModel.current = next.model;
          if (next.model) { setProviderId(next.model.providerId); setModelId(next.model.modelId); }
          first = false;
        }
        if (latest !== undefined && latest !== next.latestEntryId) onEntries.current();
        latest = next.latestEntryId;
      } catch {
        if (active) { setStatus(null); setStatusError("生成状态读取失败，正在重新确认；请勿重复创建消息。"); }
      } finally {
        if (active) timer = setTimeout(() => void poll(), 1000);
      }
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [conversationId]);

  async function send() {
    if (working.current || !status || status.running || modelsLoading) return;
    if (!pending.current) pending.current = { conversationId, requestId: crypto.randomUUID(), providerId, modelId, content: content.trim() };
    const input = pending.current;
    if (!input.content) return;
    working.current = true;
    setAction("send");
    setError("");
    try {
      await invoke("conversation_chat_submit", { input });
      if (mounted.current) {
        pending.current = null;
        setHasPending(false);
        setContent("");
        setStatus((previous) => previous ? { ...previous, running: true, failureReason: null } : previous);
        onEntries.current();
      }
    } catch (cause: unknown) {
      if (mounted.current) {
        setError(message(cause));
        const definitive = rejected(cause);
        if (definitive) pending.current = null;
        setHasPending(!definitive);
      }
    } finally {
      working.current = false;
      if (mounted.current) setAction(null);
    }
  }
  async function resume() {
    if (working.current || !status || status.running || hasPending) return;
    if (!pendingResume.current) pendingResume.current = { conversationId, requestId: crypto.randomUUID() };
    working.current = true;
    setAction("resume");
    setError("");
    try {
      await invoke("conversation_chat_resume", { input: pendingResume.current });
      if (mounted.current) {
        pendingResume.current = null;
        setHasPendingResume(false);
        setStatus((previous) => previous ? { ...previous, running: true, failureReason: null, canResume: false } : previous);
        onEntries.current();
      }
    } catch (cause: unknown) {
      if (mounted.current) {
        setError(message(cause));
        if (rejected(cause)) pendingResume.current = null;
        setHasPendingResume(!rejected(cause));
      }
    } finally { working.current = false; if (mounted.current) setAction(null); }
  }
  async function stop() {
    if (working.current) return;
    working.current = true;
    setAction("stop");
    setError("");
    try {
      await invoke("conversation_chat_abort", { conversationId });
      if (mounted.current) onEntries.current();
    } catch { if (mounted.current) setError("停止结果尚未确认，请等待状态刷新。"); }
    finally { working.current = false; if (mounted.current) setAction(null); }
  }
  const selected = models.find((item) => item.id === modelId);
  const disabled = !status || status.running || action !== null || hasPending || hasPendingResume;
  return (
    <div className="chat-panel" aria-label="模型对话">
      <div className="transcript-heading"><strong>发送消息</strong>
        <button type="button" disabled={disabled} onClick={() => setRevision((value) => value + 1)}>刷新模型目录</button>
      </div>
      <label className="provider-field"><span>对话服务商</span>
        <select aria-label="对话服务商" value={providerId} disabled={disabled || providers.length === 0} onChange={(event) => setProviderId(event.target.value)}>
          {providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      <label className="provider-field"><span>对话模型</span>
        <select aria-label="对话模型" value={modelId} disabled={disabled || modelsLoading} onChange={(event) => setModelId(event.target.value)}>
          <option value="">请选择可用模型</option>
          {models.map((item) => <option key={item.id} value={item.id} disabled={!supported(item.api)}>{item.name}{supported(item.api) ? "" : "（暂不支持）"}</option>)}
        </select>
      </label>
      <textarea aria-label="消息内容" value={content} maxLength={8000} rows={4} disabled={disabled}
        placeholder="输入消息，最多 8000 字符" onChange={(event) => setContent(event.target.value)} />
      <div className="provider-actions">
        <button type="button" className="primary" disabled={!status || status.running || action !== null || hasPendingResume || modelsLoading || !content.trim() || (!hasPending && (!selected || !supported(selected.api)))} onClick={() => void send()}>
          {action === "send" ? "提交中..." : hasPending ? "重试同一请求" : "发送消息"}
        </button>
        <button type="button" disabled={!status?.running || action !== null} onClick={() => void stop()}>{action === "stop" ? "正在停止..." : "停止生成"}</button>
        {(status?.canResume || hasPendingResume) && <button type="button" disabled={!status || status.running || action !== null || hasPending} onClick={() => void resume()}>
          {action === "resume" ? "正在继续..." : hasPendingResume ? "重试同一继续请求" : "继续上次生成"}
        </button>}
      </div>
      {(status?.canResume || hasPendingResume) && <p className="muted">继续使用上次发送时的模型{status?.model ? `（${status.model.providerId} / ${status.model.modelId}）` : ""}，不新增用户消息；会再次调用模型，可能产生费用。</p>}
      <p className="muted">发送会调用所选服务商，可能产生费用；本阶段为文本对话，不执行工具。</p>
      <p className="muted">生成期间退出后，未完成请求会在重启时恢复，可能再次调用模型；需要结束时请先停止生成。</p>
      {status?.running && <div role="status"><p>正在生成回复...</p>{status.partialText && <pre className="transcript-content">{status.partialText}</pre>}</div>}
      {!status?.running && status?.failureReason && <p role="status" className="muted">{status.failureReason === "aborted" ? "生成已停止，已产生的历史会保留。" : "本轮未完成回复，请检查模型、凭据或网络后再发送。"}</p>}
      {(error || catalogError || statusError) && <div role="alert" className="error">{error || catalogError || statusError}</div>}
    </div>
  );
}
