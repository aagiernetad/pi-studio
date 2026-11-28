
import { useEffect, useLayoutEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import ConversationPanel from "./ConversationPanel";
import ProviderSettings from "./ProviderSettings";
import StudioIcon from "./StudioIcon";
import AppearanceSettings from "./AppearanceSettings";
import WorkspaceBrowser from "./WorkspaceBrowser";
import { APPEARANCE_KEY, loadAppearance, type Appearance, type ThemeMode } from "./appearance";
import "./App.css";
import "./workspace.css";

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

type StudioPage = "conversations" | "workspace" | "providers" | "appearance" | "diagnostics";

type Theme = "light" | "dark";
const THEME_KEY = "pi-studio.theme";

function savedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch { return null; }
}

function App() {
  const [appearance, setAppearance] = useState<Appearance>(loadAppearance);
  const [themePreference, setThemePreference] = useState<Theme | null>(savedTheme);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const theme = themePreference ?? (systemDark ? "dark" : "light");
  useLayoutEffect(() => {
    Object.assign(document.documentElement.dataset, {
      theme, palette: theme === "dark" ? appearance.darkPalette : appearance.lightPalette,
      accent: appearance.accent, corners: appearance.corners, codeFont: appearance.codeFont,
      density: appearance.density, motion: appearance.motion, ambient: appearance.ambient,
      readingWidth: appearance.width, ligatures: String(appearance.ligatures), scroll: appearance.scroll,
    });
  }, [theme, appearance]);
  function updateAppearance(next: Appearance) {
    setAppearance(next);
    try { localStorage.setItem(APPEARANCE_KEY, JSON.stringify(next)); } catch { /* 本次外观仍有效。 */ }
  }
  function updateMode(mode: ThemeMode) {
    setThemePreference(mode === "system" ? null : mode);
    try {
      if (mode === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, mode);
    } catch { /* 本次选择仍有效。 */ }
  }
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const update = () => { document.documentElement.dataset.motionPaused = String(document.hidden || !document.hasFocus()); };
    const pause = () => { document.documentElement.dataset.motionPaused = "true"; };
    window.addEventListener("focus", update);
    window.addEventListener("blur", pause);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      window.removeEventListener("focus", update); window.removeEventListener("blur", pause);
      document.removeEventListener("visibilitychange", update);
      delete document.documentElement.dataset.motionPaused;
    };
  }, []);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    updateMode(next);
  }

  const [page, setPage] = useState<StudioPage>("conversations");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [catalogRevision, setCatalogRevision] = useState(0);
  useEffect(() => { window.scrollTo(0, 0); }, [page]);

  function navigate(next: StudioPage) {
    if (settingsBusy || next === page) return;
    if (page === "providers") setCatalogRevision((value) => value + 1);
    setPage(next);
  }

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
    <main className={"studio studio-" + page}>
      <div className="app-topbar">
      <header className="header">
        <div>
          <h1><span className="brand-mark" aria-hidden="true">π</span> Pi Studio</h1>
          <p>本地优先的智能工作空间</p>
        </div>

        <div className={`status ${status}`}>
          <span className="status-dot" />
          {status === "online"
            ? "已连接"
            : status === "checking"
              ? "连接中"
              : "未连接"}
        </div>
      </header>

      <nav className="studio-navigation" aria-label="工作区导航">
        {([
          ["conversations", "会话", "studio-conversations"],
          ["workspace", "工作区", "studio-workspace"],
          ["providers", "服务商", "studio-providers"],
          ["appearance", "外观", "studio-appearance"],
          ["diagnostics", "诊断", "studio-diagnostics"],
        ] as const).map(([key, label, target]) => <button key={key} type="button"
          title={label} aria-current={page === key ? "page" : undefined} aria-controls={target}
          disabled={settingsBusy} onClick={() => navigate(key)}><StudioIcon name={key} /><span>{label}</span></button>)}
      </nav>
      <button type="button" className="theme-toggle" onClick={toggleTheme}
        aria-label={theme === "dark" ? "切换至浅色模式" : "切换至深色模式"}
        title={theme === "dark" ? "浅色模式" : "深色模式"}>
        <StudioIcon name={theme === "dark" ? "sun" : "moon"} />
      </button>
      </div>

      <section id="studio-conversations" aria-labelledby="conversations-heading" hidden={page !== "conversations"}>
        <h2 id="conversations-heading" className="sr-only">会话工作台</h2>
        <ConversationPanel catalogRevision={catalogRevision} onOpenProviders={() => navigate("providers")} onOpenAppearance={() => navigate("appearance")} />
      </section>
      <section id="studio-workspace" hidden={page !== "workspace"} aria-label="工作区"><WorkspaceBrowser /></section>
      <section id="studio-providers" aria-labelledby="providers-heading" hidden={page !== "providers"}>
        <div className="workspace-heading"><h2 id="providers-heading">服务商与模型</h2></div>
        {page === "providers" && <ProviderSettings onBusyChange={setSettingsBusy} />}
        {settingsBusy && <p className="muted" role="status">正在处理服务商操作，完成后可切换页面。</p>}
      </section>
      <section id="studio-appearance" aria-labelledby="appearance-heading" hidden={page !== "appearance"}>
        <div className="workspace-heading"><h2 id="appearance-heading">外观</h2></div>
        {page === "appearance" && <AppearanceSettings value={appearance} mode={themePreference ?? "system"} theme={theme}
          onChange={updateAppearance} onModeChange={updateMode} />}
      </section>
      <section id="studio-diagnostics" aria-labelledby="diagnostics-heading" hidden={page !== "diagnostics"}>
        <div className="workspace-heading"><h2 id="diagnostics-heading">运行诊断</h2></div>

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

      </section>

    </main>
  );
}

export default App;
