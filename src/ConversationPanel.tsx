
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ConversationTranscript from "./ConversationTranscript";
import ConversationChat from "./ConversationChat";
import ConversationTitleEditor from "./ConversationTitleEditor";
import ConversationUsage from "./ConversationUsage";

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

export default function ConversationPanel() {
  const [conversations, setConversations] = useState<
    UserConversation[]
  >([]);
  const [selectedId, setSelectedId] = useState<number | null>(
    null,
  );
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
      setTitle("");
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
    <section className="panel conversation-panel">
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
        <input
          aria-label="会话标题"
          value={title}
          maxLength={120}
          disabled={creating}
          placeholder="会话标题（可选）"
          onChange={(event) => setTitle(event.target.value)}
        />

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
        <button type="submit" disabled={creating || renaming}>搜索</button>
        <button type="button" disabled={creating || renaming || (!searchDraft && !query)} onClick={() => {
          setSearchDraft(""); setQuery(""); setError(""); setNotice("");
        }}>清除搜索</button>
      </form>
      {notice && <p className="provider-notice" role="status">{notice}</p>}

      <div className="conversation-layout">
        <div className="conversation-sidebar">
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
                  type="button"
                  aria-pressed={selectedId === conversation.id}
                  className={
                    selectedId === conversation.id
                      ? "conversation-item active"
                      : "conversation-item"
                  }
                  onClick={() => setSelectedId(conversation.id)}
                >
                  <strong>{conversation.title}</strong>
                  <span>
                    #{conversation.id} ·{" "}
                    {new Date(
                      conversation.createdAt,
                    ).toLocaleString("zh-CN")}
                  </span>
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
        </div>

        <div className="conversation-detail">
          {selected ? (
            <>
              <div className="conversation-label">当前会话</div>
              <ConversationTitleEditor key={`title-${selected.id}`} conversation={selected}
                disabled={loading || loadingMore || creating} onSavingChange={setRenaming} onRenamed={(renamed) => {
                const matches = renamed.title.toLowerCase().includes(query.toLowerCase());
                setConversations((previous) => previous.map((item) => item.id === renamed.id ? renamed : item)
                  .filter((item) => item.id !== renamed.id || matches));
                if (!matches) setSelectedId(null);
                setNotice(matches ? "会话标题已更新。" : "标题已更新；该会话不再匹配当前搜索，可清除搜索查看。");
              }} />

              <p className="muted">
                Conversation ID：{selected.id}
              </p>

              <p className="muted">
                创建时间：
                {new Date(
                  selected.createdAt,
                ).toLocaleString("zh-CN")}
              </p>

              {selected.forkedFrom && <p className="muted">分支来自会话 #{selected.forkedFrom.conversationId} 的回复 #{selected.forkedFrom.entryId}；用量仅统计此分支的新请求。</p>}
              <ConversationChat key={`chat-${selected.id}`} conversationId={selected.id}
                onEntriesChanged={() => setTranscriptRevision((value) => value + 1)} />
              <ConversationUsage key={`usage-${selected.id}`} conversationId={selected.id} revision={transcriptRevision} />
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
            </>
          ) : (
            <div className="conversation-placeholder">
              请选择或新建一个会话
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
