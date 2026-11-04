
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

interface RuntimeInfo {
  name: string;
  platform: string;
  nodeVersion: string;
  pid: number;
  uptime: number;
}

interface PingResult {
  message: string;
  runtime: string;
  pid: number;
}

interface RuntimeEvent {
  version: number;
  kind: "event";
  event: string;
  sequence: number;
  data: Record<string, unknown>;
}

type RuntimeStatus = "checking" | "online" | "offline";

function App() {
  const [status, setStatus] =
    useState<RuntimeStatus>("checking");

  const [info, setInfo] = useState<RuntimeInfo | null>(null);
  const [message, setMessage] = useState("Hello Pi Studio");
  const [pingResult, setPingResult] =
    useState<PingResult | null>(null);

  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // 启动时检查 Runtime，并监听事件
  useEffect(() => {
    let active = true;

    const subscription = listen<RuntimeEvent>(
      "runtime-event",
      ({ payload }) => {
        if (!active) return;

        setEvents((previous) =>
          [payload, ...previous].slice(0, 30),
        );
      },
    );

    void subscription.catch((err: unknown) => {
      if (active) {
        setError(`事件监听失败：${String(err)}`);
      }
    });

    void invoke<RuntimeInfo>("runtime_info")
      .then((result) => {
        if (!active) return;

        setInfo(result);
        setStatus("online");
      })
      .catch((err: unknown) => {
        if (!active) return;

        setStatus("offline");
        setError(String(err));
      });

    return () => {
      active = false;

      // 防止 React 组件卸载后留下重复监听器
      void subscription
        .then((unlisten) => unlisten())
        .catch(() => {});
    };
  }, []);

  async function pingRuntime() {
    setBusy(true);
    setError("");

    try {
      const result = await invoke<PingResult>(
        "runtime_ping",
        { message },
      );

      setPingResult(result);
      setStatus("online");
    } catch (err) {
      setError(String(err));
      setStatus("offline");
    } finally {
      setBusy(false);
    }
  }

  async function refreshInfo() {
    setBusy(true);
    setError("");

    try {
      const result =
        await invoke<RuntimeInfo>("runtime_info");

      setInfo(result);
      setStatus("online");
    } catch (err) {
      setStatus("offline");
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="studio">
      <header className="header">
        <div>
          <h1>Pi Studio</h1>
          <p>Local-first Agent Runtime</p>
        </div>

        <div className={`status ${status}`}>
          <span className="status-dot" />
          {status === "online"
            ? "Runtime Online"
            : status === "checking"
              ? "Connecting..."
              : "Runtime Offline"}
        </div>
      </header>

      <section className="panel">
        <div className="section-heading">
          <h2>Runtime 信息</h2>
          <button
            onClick={refreshInfo}
            disabled={busy}
          >
            刷新状态
          </button>
        </div>

        {info ? (
          <div className="info-grid">
            <div>
              <span>Runtime</span>
              <strong>{info.name}</strong>
            </div>
            <div>
              <span>Platform</span>
              <strong>{info.platform}</strong>
            </div>
            <div>
              <span>Node.js</span>
              <strong>{info.nodeVersion}</strong>
            </div>
            <div>
              <span>Process ID</span>
              <strong>{info.pid}</strong>
            </div>
            <div>
              <span>Uptime</span>
              <strong>
                {info.uptime.toFixed(1)} s
              </strong>
            </div>
          </div>
        ) : (
          <p className="muted">尚未获取 Runtime 信息</p>
        )}
      </section>

      <section className="panel">
        <h2>IPC 通信测试</h2>

        <p className="muted">
          React → Tauri → Rust → Node.js
        </p>

        <div className="request-row">
          <input
            value={message}
            onChange={(event) =>
              setMessage(event.target.value)
            }
            placeholder="输入 Ping 消息"
            maxLength={4096}
          />

          <button
            className="primary"
            disabled={busy}
            onClick={pingRuntime}
          >
            {busy ? "请求中..." : "发送 Ping"}
          </button>
        </div>

        {pingResult && (
          <div className="result">
            <strong>Runtime Response</strong>
            <pre>{JSON.stringify(pingResult, null, 2)}</pre>
          </div>
        )}

        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Runtime Events</h2>
        {events.length === 0 ? (
          <p className="muted">
            暂无事件。当前 Ping / Info Handler
            不会主动生成进度事件。
          </p>
        ) : (
          <div className="event-list">
            {events.map((event, index) => (
              <pre key={`${event.sequence}-${index}`}>
                {JSON.stringify(event, null, 2)}
              </pre>
            ))}
          </div>
        )}
      </section>

      <footer>
        Pi Studio · Runtime IPC Protocol V1
      </footer>
    </main>
  );
}

export default App;
