
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ChatMessage from "./ChatMessage";
import StudioIcon from "./StudioIcon";
import ThinkingBlock from "./ThinkingBlock";
import ResponseMetrics from "./ResponseMetrics";

type TranscriptEntry = {
  id: number;
  kind: string;
  data: unknown;
  model: unknown;
};

type TranscriptCursor = Record<string, unknown>;

type TranscriptPage = {
  items: TranscriptEntry[];
  nextCursor: TranscriptCursor | null;
};

type Props = {
  conversationId: number;
  revision?: number;
  onForked?: (conversation: { id: number; title: string; createdAt: number }) => void;
  forkDisabled?: boolean;
};

const PAGE_SIZE = 10;

function formatContent(value: unknown): string {
  if (value === null || value === undefined) {
    return "无内容";
  }

  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value, null, 2) ?? "无内容";
}

function modelText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const text: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record: Record<string, unknown> = item;
    if (record.role !== "user" && record.role !== "assistant" && record.role !== "toolResult") continue;
    if (record.stopReason === "error") { text.push("模型请求失败，请检查凭据、模型权限或网络。"); continue; }
    if (typeof record.content === "string") text.push(record.content);
    else if (Array.isArray(record.content)) for (const part of record.content) {
      if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") text.push(part.text);
    }
  }
  return text.length ? text.join("\n") : null;
}

function modelThinking(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const thinking: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || item.role !== "assistant" || item.stopReason === "error" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part?.type === "thinking" && !part.redacted && typeof part.thinking === "string") thinking.push(part.thinking);
    }
  }
  return thinking.join("\n");
}

function sandboxScripts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(message => message?.role === "assistant" && Array.isArray(message.content)
    ? message.content.flatMap((part: unknown) => {
      if (!part || typeof part !== "object" || !("type" in part) || part.type !== "toolCall" ||
        !("name" in part) || part.name !== "codemode" || !("arguments" in part)) return [];
      const args = part.arguments;
      return args && typeof args === "object" && "code" in args && typeof args.code === "string" ? [args.code] : [];
    }) : []);
}

export default function ConversationTranscript({
  conversationId,
  revision = 0,
  onForked,
  forkDisabled = false,
}: Props) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [nextCursor, setNextCursor] =
    useState<TranscriptCursor | null>(null);

  const [outlineQuery, setOutlineQuery] = useState("");
  const outline = useRef<HTMLDetailsElement>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const generation = useRef(0);
  const list = useRef<HTMLDivElement>(null);
  const olderAnchor = useRef<{ height: number; top: number } | null>(null);
  const showLatest = useRef(true);

  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    function align() {
      if (!element || element.clientHeight === 0) return;
      if (olderAnchor.current) {
        element.scrollTop = olderAnchor.current.top + element.scrollHeight - olderAnchor.current.height;
        olderAnchor.current = null;
      } else if (showLatest.current) {
        element.scrollTop = element.scrollHeight;
        showLatest.current = false;
      }
    }
    align();
    // 会话页隐藏时不计算滚动位置，重新可见后再定位。
    const observer = new ResizeObserver(align);
    observer.observe(element);
    return () => observer.disconnect();
  }, [entries, loading]);
  const mounted = useRef(true);
  const pendingFork = useRef<{ requestId: string; entryId: number } | null>(null);
  const [forking, setForking] = useState(false);
  const [forkError, setForkError] = useState("");
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function fork(entryId: number) {
    if (forking || forkDisabled || !onForked) return;
    pendingFork.current ??= { requestId: crypto.randomUUID(), entryId };
    setForking(true);
    setForkError("");
    try {
      const result = await invoke<{ conversation: { id: number; title: string; createdAt: number } }>("conversation_fork", {
        input: { conversationId, ...pendingFork.current },
      });
      if (!mounted.current) return;
      pendingFork.current = null;
      onForked(result.conversation);
    } catch {
      if (mounted.current) setForkError("创建分支结果未确认，请重试同一请求。");
    } finally {
      if (mounted.current) setForking(false);
    }
  }

  // 会话变化或手动刷新时，重新加载第一页。
  useEffect(() => {
    let cancelled = false;
    generation.current += 1;
    olderAnchor.current = null;
    showLatest.current = true;

    setLoading(true);
    setLoadingMore(false);
    setEntries([]);
    setNextCursor(null);
    setError("");

    void invoke<TranscriptPage>("conversation_entries", {
      conversationId,
      limit: PAGE_SIZE,
    })
      .then((page) => {
        if (cancelled) return;

        setEntries(page.items);
        setNextCursor(page.nextCursor);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(`读取历史失败：${String(cause)}`);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [conversationId, refreshKey, revision]);

  async function loadMore() {
    if (
      nextCursor === null ||
      loading ||
      loadingMore
    ) {
      return;
    }

    setLoadingMore(true);
    const currentGeneration = generation.current;
    setError("");

    try {
      const page = await invoke<TranscriptPage>(
        "conversation_entries",
        {
          conversationId,
          limit: PAGE_SIZE,
          cursor: nextCursor,
        },
      );

      if (currentGeneration !== generation.current) return;
      if (list.current) olderAnchor.current = { height: list.current.scrollHeight, top: list.current.scrollTop };
      setEntries((previous) => {
        const known = new Set(previous.map((entry) => entry.id));
        return [...previous, ...page.items.filter((entry) => !known.has(entry.id))];
      });

      setNextCursor(page.nextCursor);
    } catch (cause) {
      if (currentGeneration !== generation.current) return;
      setError(`加载更早记录失败：${String(cause)}`);
    } finally {
      if (currentGeneration === generation.current) setLoadingMore(false);
    }
  }

  const questions = [...entries].sort((a, b) => a.id - b.id)
    .filter(entry => entry.kind === "studio.chat-input" || entry.kind === "pi.user")
    .map((entry, index) => ({ id: entry.id, number: index + 1, text: modelText(entry.model) ?? formatContent(entry.data) }));
  function jumpTo(id: number) {
    const element = list.current?.querySelector<HTMLElement>('[data-entry-id="' + id + '"]');
    if (!element || !list.current) return;
    list.current.scrollTo({ top: list.current.scrollTop + element.getBoundingClientRect().top - list.current.getBoundingClientRect().top, behavior: "instant" });
    element.focus({ preventScroll: true });
    if (outline.current) outline.current.open = false;
  }
  useEffect(() => {
    function jump(event: KeyboardEvent) {
      if (!event.altKey || event.ctrlKey || event.metaKey || !["ArrowUp", "ArrowDown"].includes(event.key) || !list.current?.clientHeight) return;
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable], dialog[open]')) return;
      const top = list.current.getBoundingClientRect().top;
      const targets = questions.map(question => ({ id: question.id,
        top: list.current?.querySelector('[data-entry-id="' + question.id + '"]')?.getBoundingClientRect().top ?? top }));
      const earlier = targets.filter(item => item.top < top - 4);
      const target = event.key === "ArrowUp" ? earlier[earlier.length - 1] : targets.find(item => item.top > top + 4);
      if (target) { event.preventDefault(); jumpTo(target.id); }
    }
    window.addEventListener("keydown", jump);
    return () => window.removeEventListener("keydown", jump);
  });

  return (
    <div className="transcript-panel">
      <div className="transcript-heading">
        <strong className="sr-only">对话消息</strong>
        <details className="conversation-outline" ref={outline} onKeyDown={event => { if (event.key === "Escape") event.currentTarget.open = false; }}>
          <summary><StudioIcon name="outline" /><span>大纲</span></summary>
          <div className="outline-content" aria-label="已加载对话大纲">
            <input type="search" aria-label="搜索对话大纲" placeholder="搜索问题..." value={outlineQuery} onChange={event => setOutlineQuery(event.target.value)} />
            <div className="outline-results">
              {questions.filter(question => question.text.toLowerCase().includes(outlineQuery.toLowerCase().trim())).map(question =>
                <button type="button" key={question.id} title={question.text} data-question-id={question.id} onClick={() => jumpTo(question.id)}>
                  <span aria-hidden="true">{question.number}</span><span>{question.text}</span>
                </button>)}
              {!questions.length && <p className="muted">暂无已加载的问题。</p>}
            </div>
            {nextCursor !== null && <button type="button" disabled={loading || loadingMore} onClick={() => void loadMore()}>{loadingMore ? "加载中..." : "加载更早问题"}</button>}
          </div>
        </details>

        <button
          type="button"
          disabled={loading || loadingMore}
          onClick={() =>
            setRefreshKey((value) => value + 1)
          }
        >
          刷新历史
        </button>
        <button type="button" onClick={() => { const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches; list.current?.scrollTo({ top: list.current.scrollHeight, behavior: !reduced && document.documentElement.dataset.motion !== "off" && document.documentElement.dataset.scroll === "smooth" ? "smooth" : "instant" }); }}>回到最新</button>
      </div>



      {forkError && <div className="error" role="alert">{forkError}
        <button type="button" disabled={forking || forkDisabled} onClick={() => { if (pendingFork.current) void fork(pendingFork.current.entryId); }}>重试创建分支</button>
      </div>}

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}

      {nextCursor !== null && !loading && (
        <button
          type="button"
          className="conversation-more"
          disabled={loadingMore}
          onClick={() => void loadMore()}
        >
          {loadingMore
            ? "加载中..."
            : "加载更早记录"}
        </button>
      )}

      {loading ? (
        <p className="muted">正在读取历史记录...</p>
      ) : entries.length === 0 ? (
        <div className="conversation-placeholder">
          <span className="conversation-greeting">有什么我可以帮你的？</span>
        </div>
      ) : (
        <div className="transcript-list" ref={list} role="region" aria-label="对话消息" tabIndex={0}>
          {[...entries].sort((a, b) => a.id - b.id).map((entry) => (
            <article
              className={`transcript-entry ${entry.kind === "studio.chat-input" || entry.kind === "pi.user" ? "message-user" : entry.kind === "pi.assistant" ? "message-assistant" : "message-boundary"}`}
              key={entry.id}
              data-entry-id={entry.id}
              tabIndex={-1}
            >
              <div className="transcript-entry-header">
                <strong>{entry.kind === "studio.chat-input" || entry.kind === "pi.user" ? "你" : entry.kind === "pi.assistant" ? "助手" : entry.kind === "pi.reset" ? "新上下文" : entry.kind === "pi.tool-result" ? "计算结果" : entry.kind}</strong>

              </div>

              {entry.kind === "pi.assistant" && <ThinkingBlock text={modelThinking(entry.model)} />}
              {sandboxScripts(entry.model).map((code, index) => <details className="chat-notes" key={index}>
                <summary>沙箱计算</summary><pre className="transcript-content">{code}</pre>
              </details>)}
              {entry.kind === "pi.reset" ? <p className="muted">此前消息保留在历史中，后续模型请求从这里开始。</p> : modelText(entry.model) !== null && ["studio.chat-input", "pi.user", "pi.assistant"].includes(entry.kind) ?
                <ChatMessage text={modelText(entry.model) ?? ""} markdown={entry.kind === "pi.assistant"} /> :
                entry.kind === "pi.assistant" && (modelThinking(entry.model) || sandboxScripts(entry.model).length) ? null : <pre className="transcript-content">{modelText(entry.model) ?? formatContent(entry.data)}</pre>}

              {entry.kind === "pi.assistant" && <ResponseMetrics messages={entry.model} />}

              {onForked && entry.kind === "pi.assistant" && Array.isArray(entry.model) && entry.model.some((message: unknown) => {
                if (!message || typeof message !== "object") return false;
                const value = message as Record<string, unknown>;
                return value.role === "assistant" && (value.stopReason === "stop" || value.stopReason === "length");
              }) && <button type="button" disabled={forkDisabled || forking || pendingFork.current !== null}
                title="继承截至这条回复的上下文，原会话保留" onClick={() => void fork(entry.id)}>
                从此处新建分支会话
              </button>}

              {entry.model !== null &&
                entry.model !== undefined && (
                  <details className="transcript-model">
                    <summary>查看模型内容</summary>
                    <span>Entry #{entry.id}</span>
                    <pre>
                      {formatContent(entry.model)}
                    </pre>
                  </details>
                )}
            </article>
          ))}
        </div>
      )}


    </div>
  );
}
