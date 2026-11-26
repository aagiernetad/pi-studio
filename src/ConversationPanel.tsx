
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ConversationTranscript from "./ConversationTranscript";
import ConversationChat, { type ConversationDraft, type DraftUpdate } from "./ConversationChat";
import ConversationTitleEditor from "./ConversationTitleEditor";
import ConversationUsage from "./ConversationUsage";
import StudioIcon from "./StudioIcon";

type UserConversation = {
  id: number;
  title: string;
  createdAt: number;
  forkedFrom?: { conversationId: number; entryId: number };
};

type ConversationListResult = {
  items: UserConversation[];
  nextBeforeId: number | null;
};

type ConversationCreateResult = {
  conversation: UserConversation;
};

const PAGE_SIZE = 20;

export default function ConversationPanel({ catalogRevision = 0, onOpenProviders, onOpenAppearance }: { catalogRevision?: number; onOpenProviders: () => void; onOpenAppearance: () => void }) {
  // 仅保存在当前工作台内存中，不写入浏览器存储、Transcript 或 SQLite。
  const drafts = useRef(new Map<number, ConversationDraft>());
  function updateDraft(id: number, update: DraftUpdate) {
    const current = drafts.current.get(id);
    if (update.type === "edit") {
      if (current?.input) return;
      if (update.content) drafts.current.set(id, { content: update.content, input: null });
      else drafts.current.delete(id);
    } else if (update.type === "pending") {
      drafts.current.set(id, { content: update.content, input: update.input });
    } else if (current?.input?.requestId === update.requestId) {
      // 迟到结果只能结算自身请求，不能抹掉另一会话或后来的草稿。
      if (update.clear) drafts.current.delete(id);
      else drafts.current.set(id, { ...current, input: null });
    }
  }

  const [conversations, setConversations] = useState<
    UserConversation[]
  >([]);
  const [selectedId, setSelectedId] = useState<number | null>(
    null,
  );
  const [listOpen, setListOpen] = useState(false);
  const naming = useRef<HTMLDetailsElement>(null);
  const [title, setTitle] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const [renaming, setRenaming] = useState(false);
  const listGeneration = useRef(0);
  const [nextBeforeId, setNextBeforeId] = useState<number | null>(
    null,
  );

  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState("");
  const [transcriptRevision, setTranscriptRevision] = useState(0);

  // 创建请求失败时，保留原来的业务 requestId。
  // 再次点击创建会重试同一个请求，而不是生成新会话。
  const pendingCreate = useRef<{
    requestId: string;
    title: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    listGeneration.current += 1;

    setLoading(true);
    setLoadingMore(false);

    void invoke<ConversationListResult>("conversation_list", {
      limit: PAGE_SIZE,
      query,
    })
      .then((page) => {
        if (cancelled) return;

        setConversations(page.items);
        setNextBeforeId(page.nextBeforeId);

        setSelectedId((current) => {
          if (page.items.some((item) => item.id === current)) {
            return current;
          }

          return page.items[0]?.id ?? null;
        });
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(`加载会话失败：${String(cause)}`);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      listGeneration.current += 1;
    };
  }, [refreshKey, query]);

  async function createConversation() {
    if (creating || loading || renaming) return;

    if (!pendingCreate.current) {
      pendingCreate.current = {
        requestId: crypto.randomUUID(),
        title: title.trim() || "新建会话",
      };
    }

    const request = pendingCreate.current;

    setCreating(true);
    setError("");

    try {
      const result = await invoke<ConversationCreateResult>(
        "conversation_create",
        {
          requestId: request.requestId,
          title: request.title,
        },
      );

      const created = result.conversation;

      setConversations((previous) => [
        created,
        ...previous.filter((item) => item.id !== created.id),
      ]);

      setSelectedId(created.id);
      setListOpen(false);
      setTitle("");
      if (naming.current) naming.current.open = false;
      setSearchDraft("");
      setQuery("");
      pendingCreate.current = null;
    } catch (cause) {
      setError(
        `创建会话失败：${String(cause)}。再次点击可重试同一请求。`,
      );
    } finally {
      setCreating(false);
    }
  }

  async function loadMore() {
    if (nextBeforeId === null || loading || loadingMore || creating || renaming) {
      return;
    }

    setLoadingMore(true);
    const generation = listGeneration.current;
    setError("");

    try {
      const page = await invoke<ConversationListResult>(
        "conversation_list",
        {
          limit: PAGE_SIZE,
          beforeId: nextBeforeId,
          query,
        },
      );

      if (generation !== listGeneration.current) return;
      setConversations((previous) => {
        const knownIds = new Set(previous.map((item) => item.id));

        return [
          ...previous,
          ...page.items.filter((item) => !knownIds.has(item.id)),
        ];
      });

      setNextBeforeId(page.nextBeforeId);
    } catch (cause) {
      if (generation !== listGeneration.current) return;
      setError(`加载更多会话失败：${String(cause)}`);
    } finally {
      if (generation === listGeneration.current) setLoadingMore(false);
    }
  }

  const selected = conversations.find(
    (item) => item.id === selectedId,
  );

  return (
    <section className="conversation-panel" aria-label="会话工作台">
      <div className={"conversation-layout " + (listOpen ? "list-open" : "")}>
        <aside className="conversation-sidebar" aria-label="会话列表">
          <button type="button" className="conversation-drawer-close" onClick={() => setListOpen(false)}>返回对话 →</button>
      <div className="section-heading">
        <h2>我的会话</h2>
        <button
          type="button"
          disabled={loading || creating || loadingMore || renaming}
          onClick={() => {
            setError("");
            setRefreshKey((value) => value + 1);
          }}
        >
          刷新列表
        </button>
      </div>

      <div className="conversation-create">
        <details className="conversation-naming" ref={naming} onKeyDown={event => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}>
          <summary aria-label="设置新会话标题" title="设置新会话标题"><StudioIcon name="edit" /></summary>
          <div>        <input
          aria-label="会话标题"
          value={title}
          maxLength={120}
          disabled={creating}
          placeholder="会话标题（可选）"
          onChange={(event) => setTitle(event.target.value)}
        />
          </div>
        </details>

        <button
          type="button"
          className="primary"
          disabled={creating || loading || renaming}
          onClick={() => void createConversation()}
        >
          {creating ? "创建中..." : "＋ 新建会话"}
        </button>
      </div>

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}

      <form className="conversation-create" role="search" aria-label="搜索会话" onSubmit={(event) => {
        event.preventDefault(); setError(""); setNotice(""); setQuery(searchDraft.trim());
      }}>
        <input aria-label="搜索会话标题" placeholder="按标题搜索全部会话" value={searchDraft} maxLength={120}
          disabled={creating || renaming} onChange={(event) => setSearchDraft(event.target.value)} />
        <button type="submit" aria-label="搜索" title="搜索" disabled={creating || renaming}><StudioIcon name="search" /></button>
        <button type="button" aria-label="清除搜索" title="清除搜索" disabled={creating || renaming || (!searchDraft && !query)} onClick={() => {
          setSearchDraft(""); setQuery(""); setError(""); setNotice("");
        }}>×</button>
      </form>
      {notice && <p className="provider-notice" role="status">{notice}</p>}


          <div className="conversation-label">会话列表</div>

          {loading ? (
            <p className="muted">正在加载会话...</p>
          ) : conversations.length === 0 ? (
            <p className="muted">{query ? "没有匹配标题的会话。" : "还没有会话，可以创建一个。"}</p>
          ) : (
            <div className="conversation-list">
              {conversations.map((conversation) => (
                <button
                  key={conversation.id}
                  data-conversation-id={conversation.id}
                  title={conversation.title}
                  aria-label={conversation.title + " #" + conversation.id}
                  type="button"
                  aria-pressed={selectedId === conversation.id}
                  className={
                    selectedId === conversation.id
                      ? "conversation-item active"
                      : "conversation-item"
                  }
                  onClick={() => { setSelectedId(conversation.id); setListOpen(false); }}
                >
                  <strong>{conversation.title}</strong>
                </button>
              ))}
            </div>
          )}

          {nextBeforeId !== null && (
            <button
              type="button"
              className="conversation-more"
              disabled={loading || loadingMore || creating || renaming}
              onClick={() => void loadMore()}
            >
              {loadingMore ? "加载中..." : "加载更多"}
            </button>
          )}

          <div className="sidebar-footer"><button type="button" onClick={onOpenAppearance}><StudioIcon name="appearance" />外观与偏好</button></div>
        </aside>
        <div className="conversation-detail">
          <button type="button" className="conversation-drawer-toggle" aria-expanded={listOpen} onClick={() => setListOpen(true)}>☰ 会话列表</button>
          {selected ? <>
            <header className="conversation-toolbar">
              <ConversationTitleEditor key={`title-${selected.id}`} conversation={selected}
                disabled={loading || loadingMore || creating} onSavingChange={setRenaming} onRenamed={(renamed) => {
                const matches = renamed.title.toLowerCase().includes(query.toLowerCase());
                setConversations((previous) => previous.map((item) => item.id === renamed.id ? renamed : item)
                  .filter((item) => item.id !== renamed.id || matches));
                if (!matches) setSelectedId(null);
                setNotice(matches ? "会话标题已更新。" : "标题已更新；该会话不再匹配当前搜索，可清除搜索查看。");
              }} />


              <details key={"inspector-" + selected.id} className="conversation-inspector" onKeyDown={(event) => {
                if (event.key === "Escape") event.currentTarget.open = false;
              }}>
                <summary>详情与用量</summary>
                <div className="inspector-content">
              <details className="conversation-metadata"><summary>会话信息</summary>
              <p className="muted">
                Conversation ID：{selected.id}
              </p>

              <p className="muted">
                创建时间：
                {new Date(
                  selected.createdAt,
                ).toLocaleString("zh-CN")}
              </p>

              </details>

              {selected.forkedFrom && <p className="muted">分支来自会话 #{selected.forkedFrom.conversationId} 的回复 #{selected.forkedFrom.entryId}；用量仅统计此分支的新请求。</p>}

              <ConversationUsage key={`usage-${selected.id}`} conversationId={selected.id} revision={transcriptRevision} />

                </div>
              </details>
            </header>
              <ConversationTranscript
                  key={selected.id}
                  conversationId={selected.id}
                  revision={transcriptRevision}
                  forkDisabled={loading || loadingMore || creating || renaming}
                  onForked={(created) => {
                    // 淘汰旧列表分页；重新查询会保留刚创建分支的选中状态。
                    listGeneration.current += 1;
                    setConversations((previous) => [created, ...previous.filter((item) => item.id !== created.id)]);
                    setSelectedId(created.id);
                    setSearchDraft(""); setQuery("");
                    setRefreshKey((value) => value + 1);
                    setNotice("分支会话已创建，可以从这条回复继续新的方向。原会话已保留。");
                  }}
               />

              <ConversationChat key={`chat-${selected.id}`} conversationId={selected.id} catalogRevision={catalogRevision}
                draft={drafts.current.get(selected.id)} onDraftUpdate={(update) => updateDraft(selected.id, update)}
                onEntriesChanged={() => setTranscriptRevision((value) => value + 1)} />

          </> : <div className="workspace-empty">
            <span className="empty-symbol" aria-hidden="true">π</span>
            <h3>从一个想法开始</h3>
            <div className="provider-actions">
              <button type="button" className="primary" disabled={creating || loading || renaming} onClick={() => void createConversation()}>新建会话</button>
              <button type="button" onClick={onOpenProviders}>配置服务商</button>
            </div>
          </div>}
        </div>
      </div>
    </section>
  );
}
