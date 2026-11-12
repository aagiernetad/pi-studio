
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ConversationTranscript from "./ConversationTranscript";

type UserConversation = {
  id: number;
  title: string;
  createdAt: number;
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
  const [nextBeforeId, setNextBeforeId] = useState<number | null>(
    null,
  );

  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState("");

  // 创建请求失败时，保留原来的业务 requestId。
  // 再次点击创建会重试同一个请求，而不是生成新会话。
  const pendingCreate = useRef<{
    requestId: string;
    title: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;

    setLoading(true);

    void invoke<ConversationListResult>("conversation_list", {
      limit: PAGE_SIZE,
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
    };
  }, [refreshKey]);

  async function createConversation() {
    if (creating || loading) return;

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
    if (nextBeforeId === null || loadingMore || creating) {
      return;
    }

    setLoadingMore(true);
    setError("");

    try {
      const page = await invoke<ConversationListResult>(
        "conversation_list",
        {
          limit: PAGE_SIZE,
          beforeId: nextBeforeId,
        },
      );

      setConversations((previous) => {
        const knownIds = new Set(previous.map((item) => item.id));

        return [
          ...previous,
          ...page.items.filter((item) => !knownIds.has(item.id)),
        ];
      });

      setNextBeforeId(page.nextBeforeId);
    } catch (cause) {
      setError(`加载更多会话失败：${String(cause)}`);
    } finally {
      setLoadingMore(false);
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
          disabled={loading || creating || loadingMore}
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
          disabled={creating || loading}
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

      <div className="conversation-layout">
        <div className="conversation-sidebar">
          <div className="conversation-label">会话列表</div>

          {loading ? (
            <p className="muted">正在加载会话...</p>
          ) : conversations.length === 0 ? (
            <p className="muted">还没有会话，可以创建一个。</p>
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
              disabled={loadingMore || creating}
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
              <h3>{selected.title}</h3>

              <p className="muted">
                Conversation ID：{selected.id}
              </p>

              <p className="muted">
                创建时间：
                {new Date(
                  selected.createdAt,
                ).toLocaleString("zh-CN")}
              </p>

              <ConversationTranscript
                  key={selected.id}
                  conversationId={selected.id}
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
