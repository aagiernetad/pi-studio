
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

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

export default function ConversationTranscript({
  conversationId,
}: Props) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [nextCursor, setNextCursor] =
    useState<TranscriptCursor | null>(null);

  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  // 会话变化或手动刷新时，重新加载第一页。
  useEffect(() => {
    let cancelled = false;

    setLoading(true);
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
  }, [conversationId, refreshKey]);

  async function loadMore() {
    if (
      nextCursor === null ||
      loading ||
      loadingMore
    ) {
      return;
    }

    setLoadingMore(true);
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

      setEntries((previous) => [
        ...previous,
        ...page.items,
      ]);

      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(`加载更早记录失败：${String(cause)}`);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="transcript-panel">
      <div className="transcript-heading">
        <strong>Transcript 历史</strong>

        <button
          type="button"
          disabled={loading || loadingMore}
          onClick={() =>
            setRefreshKey((value) => value + 1)
          }
        >
          刷新历史
        </button>
      </div>

      <p className="muted">
        显示 Durable 中的真实 Entry，最新记录在前。
      </p>

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <p className="muted">正在读取历史记录...</p>
      ) : entries.length === 0 ? (
        <div className="conversation-placeholder">
          当前会话暂无历史记录。
          <p>
            会话已经持久化，但尚未写入 Transcript。
          </p>
        </div>
      ) : (
        <div className="transcript-list">
          {entries.map((entry) => (
            <article
              className="transcript-entry"
              key={entry.id}
            >
              <div className="transcript-entry-header">
                <strong>{entry.kind}</strong>
                <span>Entry #{entry.id}</span>
              </div>

              <pre className="transcript-content">
                {formatContent(entry.data)}
              </pre>

              {entry.model !== null &&
                entry.model !== undefined && (
                  <details className="transcript-model">
                    <summary>查看模型内容</summary>
                    <pre>
                      {formatContent(entry.model)}
                    </pre>
                  </details>
                )}
            </article>
          ))}
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
    </div>
  );
}
