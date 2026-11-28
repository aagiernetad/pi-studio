import StudioIcon from "./StudioIcon";
import ConversationModelPicker from "./ConversationModelPicker";
import ConversationContextUsage from "./ConversationContextUsage";
import ThinkingBlock from "./ThinkingBlock";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { thinkingLabels, type ThinkingLevel } from "./thinking";

type Provider = { id: string; name: string };
type Model = { id: string; name: string; api: string; contextWindow?: number; maxTokens?: number; thinkingLevels?: ThinkingLevel[] };
type Status = {
  running: boolean; latestEntryId: number | null; partialText: string;
  model: { providerId: string; modelId: string } | null; failureReason: string | null;
  canResume: boolean;
  contextReset: boolean;
  thinkingLevel?: ThinkingLevel;
  sandbox?: boolean;
  phase?: "waiting" | "thinking" | "responding" | "computing" | null;
  partialThinking?: string;
  thinkingTruncated?: boolean;
};
type Input = { conversationId: number; requestId: string; providerId: string; modelId: string; content: string; thinkingLevel?: ThinkingLevel; sandbox?: boolean };
export type ConversationDraft = { content: string; input: Input | null };
export type DraftUpdate =
  | { type: "edit"; content: string }
  | { type: "pending"; content: string; input: Input }
  | { type: "settled"; requestId: string; clear: boolean };
const supported = (api: string) => ["openai-completions", "openai-responses", "anthropic-messages"].includes(api);
function message(cause: unknown): string {
  const code = typeof cause === "string" ? /^([A-Z_]+):/.exec(cause)?.[1] : "";
  const messages: Record<string, string> = {
    INVALID_PARAMS: "消息或模型参数无效。", MODEL_NOT_FOUND: "模型已不可用，请重新选择。",
    PROVIDER_NOT_CONFIGURED: "请先在服务商设置中保存 API Key。",
    CHAT_UNSUPPORTED: "当前仅支持所列文本接口的 API Key 认证。",
    THINKING_LEVEL_UNSUPPORTED: "模型的推理档位已变化，请刷新模型目录后重新选择。",
    CONVERSATION_BUSY: "该会话正在生成，请等待或停止后再发送。",
    CONVERSATION_NOT_FOUND: "当前会话不可用，请刷新会话列表。",
    REQUEST_ID_CONFLICT: "请求标识与原消息不一致，请刷新后检查历史。",
    CHAT_NOT_RESUMABLE: "当前会话已无待继续的回复，请检查最新历史。",
    CREDENTIAL_STORE_UNAVAILABLE: "无法读取系统凭据，请稍后重试。",
  };
  return (code && messages[code]) || "提交结果尚未确认，可重试同一请求，不会重复发送。";
}
const rejected = (cause: unknown) => typeof cause === "string" && /^(INVALID_PARAMS|MODEL_NOT_FOUND|PROVIDER_NOT_CONFIGURED|CHAT_UNSUPPORTED|THINKING_LEVEL_UNSUPPORTED|CONVERSATION_BUSY|CONVERSATION_NOT_FOUND|REQUEST_ID_CONFLICT|CHAT_NOT_RESUMABLE|CREDENTIAL_STORE_UNAVAILABLE):/.test(cause);

export default function ConversationChat({ conversationId, onEntriesChanged, catalogRevision = 0, draft, onDraftUpdate }: {
  conversationId: number; onEntriesChanged: () => void; catalogRevision?: number;
  draft?: ConversationDraft; onDraftUpdate: (update: DraftUpdate) => void;
}) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providerId, setProviderId] = useState("");
  const [models, setModels] = useState<Model[]>([]);
  const [modelId, setModelId] = useState("");
  const [thinkingChoice, setThinkingChoice] = useState<{ providerId: string; modelId: string; level: ThinkingLevel } | null>(null);
  const [sandbox, setSandbox] = useState(draft?.input?.sandbox ?? false);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState("");
  const [catalogError, setCatalogError] = useState("");
  const [modelError, setModelError] = useState("");
  const [error, setError] = useState(draft?.input ? "上次发送结果尚未确认，可重试同一请求核对，不会重复发送。" : "");
  const [content, setContent] = useState(draft?.content ?? "");
  const [action, setAction] = useState<"send" | "stop" | "resume" | "reset" | null>(null);
  const [hasPending, setHasPending] = useState(Boolean(draft?.input));
  const [hasPendingResume, setHasPendingResume] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [hasPendingReset, setHasPendingReset] = useState(false);
  const [revision, setRevision] = useState(0);
  const mounted = useRef(false);
  const working = useRef(false);
  const pending = useRef<Input | null>(draft?.input ?? null);
  const pendingResume = useRef<{ conversationId: number; requestId: string } | null>(null);
  const pendingReset = useRef<{ conversationId: number; requestId: string } | null>(null);
  const minimumEntryId = useRef<number | null>(null);
  const savedModel = useRef<Status["model"]>(null);
  const availableProviders = useRef<Provider[]>([]);
  const onEntries = useRef(onEntriesChanged);
  onEntries.current = onEntriesChanged;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    let active = true;
    setCatalogError("");
    void invoke<{ items: Provider[] }>("provider_list").then((catalog) => {
      if (!active) return;
      availableProviders.current = catalog.items;
      setProviders(catalog.items);
      const restored = savedModel.current;
      setProviderId((current) => catalog.items.some((item) => item.id === current) ? current :
        (restored && catalog.items.some((item) => item.id === restored.providerId) ? restored.providerId :
          (catalog.items.find((item) => item.id === "deepseek")?.id ?? catalog.items[0]?.id ?? "")));
    }).catch(() => { if (active) setCatalogError("服务商目录读取失败，请刷新模型目录。"); });
    return () => { active = false; };
  }, [revision, catalogRevision]);
  useEffect(() => {
    setModelError("");
    if (!providerId) { setModels([]); setModelId(""); setModelsLoading(false); return; }
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
    }).catch(() => { if (active) setModelError("模型目录读取失败，请刷新模型目录。"); })
      .finally(() => { if (active) setModelsLoading(false); });
    return () => { active = false; };
  }, [providerId, revision, catalogRevision]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let first = true;
    let latest: number | null | undefined;
    async function poll() {
      try {
        const next = await invoke<Status>("conversation_chat_status", { conversationId });
        if (!active) return;
        if (minimumEntryId.current !== null && (next.latestEntryId === null || next.latestEntryId < minimumEntryId.current)) return;
        setStatus(next);
        setStatusError("");
        if (first) {
          savedModel.current = next.model;
          if (next.model) setThinkingChoice({ ...next.model, level: next.thinkingLevel ?? "off" });
          if (!pending.current) setSandbox(next.sandbox ?? false);
          if (next.model && availableProviders.current.some((item) => item.id === next.model?.providerId)) { setProviderId(next.model.providerId); setModelId(next.model.modelId); }
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
    if (working.current || !status || status.running || modelsLoading || confirmReset || hasPendingReset) return;
    if (!pending.current) pending.current = { conversationId, requestId: crypto.randomUUID(), providerId, modelId, content: content.trim(),
      ...(thinkingLevel !== "off" ? { thinkingLevel } : {}), ...(sandbox ? { sandbox: true } : {}) };
    const input = pending.current;
    if (!input.content) return;
    onDraftUpdate({ type: "pending", content, input });
    working.current = true;
    setAction("send");
    setError("");
    try {
      await invoke("conversation_chat_submit", { input });
      onDraftUpdate({ type: "settled", requestId: input.requestId, clear: true });
      if (mounted.current) {
        pending.current = null;
        setHasPending(false);
        setContent("");
        setStatus((previous) => previous ? { ...previous, running: true, failureReason: null, phase: "waiting", partialThinking: "", partialText: "" } : previous);
        onEntries.current();
      }
    } catch (cause: unknown) {
      const definitive = rejected(cause);
      if (definitive) onDraftUpdate({ type: "settled", requestId: input.requestId, clear: false });
      if (mounted.current) {
        setError(message(cause));
        if (definitive) pending.current = null;
        setHasPending(!definitive);
      }
    } finally {
      working.current = false;
      if (mounted.current) setAction(null);
    }
  }
  async function resume() {
    if (working.current || !status || status.running || hasPending || confirmReset || hasPendingReset) return;
    if (!pendingResume.current) pendingResume.current = { conversationId, requestId: crypto.randomUUID() };
    working.current = true;
    setAction("resume");
    setError("");
    try {
      await invoke("conversation_chat_resume", { input: pendingResume.current });
      if (mounted.current) {
        pendingResume.current = null;
        setHasPendingResume(false);
        setStatus((previous) => previous ? { ...previous, running: true, failureReason: null, canResume: false, phase: "waiting", partialThinking: "", partialText: "" } : previous);
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
  async function resetContext() {
    if (working.current || !status || status.running || hasPending || hasPendingResume) return;
    if (!pendingReset.current) pendingReset.current = { conversationId, requestId: crypto.randomUUID() };
    working.current = true;
    setAction("reset"); setError("");
    try {
      const result = await invoke<{ entryId: number }>("conversation_context_reset", { input: pendingReset.current });
      if (mounted.current) {
        minimumEntryId.current = result.entryId;
        pendingReset.current = null;
        setHasPendingReset(false); setConfirmReset(false);
        setStatus((previous) => previous ? { ...previous, contextReset: true, failureReason: null, canResume: false } : previous);
        onEntries.current();
      }
    } catch (cause: unknown) {
      if (mounted.current) {
        const definitive = rejected(cause);
        if (definitive) pendingReset.current = null;
        setHasPendingReset(!definitive);
        setError(definitive ? message(cause) : "上下文重置结果尚未确认，请重试同一重置请求。");
      }
    } finally { working.current = false; if (mounted.current) setAction(null); }
  }
  const selected = models.find((item) => item.id === modelId);
  const thinkingLevels = selected?.thinkingLevels?.length ? selected.thinkingLevels : ["off" as const];
  const thinkingLevel = thinkingChoice?.providerId === providerId && thinkingChoice.modelId === modelId && thinkingLevels.includes(thinkingChoice.level)
    ? thinkingChoice.level : thinkingLevels[0];
  const disabled = !status || status.running || action !== null || hasPending || hasPendingResume || confirmReset || hasPendingReset;
  return (
    <div className="chat-panel" aria-label="模型对话">
      <textarea aria-label="消息内容" value={content} maxLength={8000} rows={3} disabled={disabled}
        placeholder="输入消息..." title="Ctrl / ⌘ + Enter 发送，Enter 换行" aria-describedby="chat-shortcut" onKeyDown={(event) => {
          if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey) || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (!event.repeat && !event.currentTarget.disabled && !modelsLoading && content.trim() && selected && supported(selected.api)) void send();
        }} onChange={(event) => {
          setContent(event.target.value);
          onDraftUpdate({ type: "edit", content: event.target.value });
        }} />
      <p id="chat-shortcut" className="muted chat-shortcut sr-only">Ctrl / ⌘ + Enter 发送，Enter 换行。</p>
      <div className="provider-actions composer-actions">
        <ConversationModelPicker providers={providers} models={models} providerId={providerId} modelId={modelId}
          thinkingLevels={thinkingLevels} thinkingLevel={thinkingLevel} onThinking={level => setThinkingChoice({ providerId, modelId, level })}
          disabled={disabled} loading={modelsLoading} supported={supported}
          onProvider={setProviderId} onModel={setModelId} onRefresh={() => setRevision(value => value + 1)} />
        <label className="appearance-checkbox" title="运行隔离 Python / JavaScript，无法访问本机文件、终端或网络。每次发送最多调用模型三轮。">
          <input type="checkbox" checked={sandbox} disabled={disabled} onChange={event => setSandbox(event.target.checked)} />沙箱计算
        </label>
        <button type="button" className="primary" disabled={!status || status.running || action !== null || hasPendingResume || confirmReset || hasPendingReset || modelsLoading || !content.trim() || (!hasPending && (!selected || !supported(selected.api)))} onClick={() => void send()}>
          {action === "send" ? "提交中..." : hasPending ? "重试同一请求" : "发送消息"}<StudioIcon name="send" />
        </button>
        <button type="button" disabled={!status?.running || action !== null} onClick={() => void stop()}>{action === "stop" ? "正在停止..." : "停止生成"}</button>
        {(status?.canResume || hasPendingResume) && <button type="button" disabled={!status || status.running || action !== null || hasPending || confirmReset || hasPendingReset} onClick={() => void resume()}>
          {action === "resume" ? "正在继续..." : hasPendingResume ? "重试同一继续请求" : "继续上次生成"}
        </button>}
        <button type="button" disabled={disabled} onClick={() => { setError(""); setConfirmReset(true); }}>开始新上下文</button>
        {status && <ConversationContextUsage conversationId={conversationId} latestEntryId={status.latestEntryId} contextReset={status.contextReset}
          catalogRevision={catalogRevision} disabled={disabled} onReset={() => { setError(""); setConfirmReset(true); }} />}
      </div>
      {confirmReset && <div className="result" role="group" aria-label="确认开始新上下文">
        <p>后续模型请求将不再携带此前对话。旧消息、会话、模型选择和累计用量会保留，未发送的草稿也会保留。重置本身不调用模型。</p>
        <div className="provider-actions">
          <button type="button" disabled={!status || status.running || action !== null || hasPending || hasPendingResume} onClick={() => void resetContext()}>
            {action === "reset" ? "正在重置..." : hasPendingReset ? "重试同一重置请求" : "确认开始新上下文"}
          </button>
          <button type="button" disabled={action !== null || hasPendingReset} onClick={() => setConfirmReset(false)}>取消重置</button>
        </div>
      </div>}
      {status?.contextReset && <p className="provider-notice" role="status">已开始新上下文。此前消息仍可在历史中查看。</p>}
      {(status?.canResume || hasPendingResume) && <p className="muted">继续使用上次发送时的模型{status?.model ? `（${status.model.providerId} / ${status.model.modelId}）` : ""}{status?.thinkingLevel && status.thinkingLevel !== "off" ? `及推理强度“${thinkingLabels[status.thinkingLevel]}”` : ""}，不新增用户消息；会再次调用模型，可能产生费用。</p>}
      <details className="chat-notes"><summary>对话说明</summary><div><p className="muted">草稿在本次打开期间按会话保留。</p>      <p className="muted">发送会调用所选服务商，可能产生费用。开启沙箱计算后，助手可运行 Python 或 JavaScript；每次执行限时 3 秒，Python 内存 256 MiB、JavaScript 内存 32 MiB，每次发送最多调用模型三轮。Python 支持标准库，每次执行状态独立；沙箱无法访问本机文件、终端或网络。</p>
      <p className="muted">生成期间退出后，未完成请求会在重启时恢复，可能再次调用模型；需要结束时请先停止生成。</p>
</div></details>
      {status?.running && <div className="chat-live">
        <p role="status">{status.phase === "computing" ? "正在计算..." : status.phase === "thinking" ? "正在思考..." : status.phase === "responding" ? "正在回复..." : "正在生成回复..."}</p>
        <ThinkingBlock text={status.partialThinking ?? ""} truncated={status.thinkingTruncated} />
        {status.partialText && <pre className="transcript-content">{status.partialText}</pre>}
      </div>}
      {!status?.running && status?.failureReason && <p role="status" className="muted">{status.failureReason === "aborted" ? "生成已停止，已产生的历史会保留。" : status.failureReason === "turn_limit" ? "已达到本轮计算上限，可发送新消息继续。" : "本轮未完成回复，请检查模型、凭据或网络后再发送。"}</p>}
      {(error || catalogError || modelError || statusError) && <div role="alert" className="error">{error || catalogError || modelError || statusError}</div>}
    </div>
  );
}
