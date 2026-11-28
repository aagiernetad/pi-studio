import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CopyButton } from "./ChatMessage";
import StudioIcon from "./StudioIcon";

type Workspace = { id: string; name: string };
type Item = { name: string; path: string; kind: "directory" | "file" | "blocked"; previewable: boolean };
type Listing = { workspaceId: string; path: string; items: Item[]; truncated: boolean };
type Preview = { workspaceId: string; path: string; name: string; bytes: number; text: string };
function failure(cause: unknown): string {
  const code = typeof cause === "string" ? /^([A-Z_]+):/.exec(cause)?.[1] : "";
  const messages: Record<string, string> = {
    WORKSPACE_CHANGED: "工作目录已变化，请重新载入工作区。",
    WORKSPACE_PATH_DENIED: "无法访问此路径，请重新选择目录。",
    WORKSPACE_FILE_TOO_LARGE: "文件超过 64 KiB，暂不支持预览。",
    WORKSPACE_FILE_UNSUPPORTED: "仅支持 UTF-8 文本和代码文件。",
    WORKSPACE_FILE_CHANGED: "文件读取期间发生变化，请重试。",
    WORKSPACE_NOT_DIRECTORY: "目录不可用，请重新选择。",
    WORKSPACE_PICKER_BUSY: "目录选择窗口已打开。",
  };
  return (code && messages[code]) || "读取未完成，请重试或重新载入工作区。";
}

export default function WorkspaceBrowser() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<Listing | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [query, setQuery] = useState("");
  const [initializing, setInitializing] = useState(true);
  const [loading, setLoading] = useState(false);
  const [reading, setReading] = useState(false);
  const [action, setAction] = useState<"choose" | "close" | "reload" | null>(null);
  const [error, setError] = useState("");
  const [listError, setListError] = useState("");
  const [readError, setReadError] = useState("");
  const [revision, setRevision] = useState(0);
  const mounted = useRef(false);
  const working = useRef(false);
  const readVersion = useRef(0);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    const version = readVersion.current;
    void invoke<{ workspace: Workspace | null }>("workspace_state").then(result => {
      if (active && version === readVersion.current) setWorkspace(result.workspace);
    }).catch(cause => { if (active && version === readVersion.current) setError(failure(cause)); })
      .finally(() => { if (active) setInitializing(false); });
    return () => { active = false; mounted.current = false; readVersion.current++; };
  }, []);
  useEffect(() => {
    let active = true;
    setListing(null); setListError(""); setQuery("");
    if (!workspace) return;
    setLoading(true);
    void invoke<Listing>("workspace_list", { input: { workspaceId: workspace.id, path } }).then(result => {
      if (active && result.workspaceId === workspace.id && result.path === path) setListing(result);
    }).catch(cause => { if (active) setListError(failure(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [workspace?.id, path, revision]);

  function adopt(next: Workspace | null) {
    readVersion.current++; setReading(false); setPreview(null); setReadError("");
    setLoading(false);
    setPath(""); setWorkspace(next); setRevision(value => value + 1);
  }
  async function change(next: "choose" | "close" | "reload") {
    if (working.current) return;
    working.current = true; setAction(next); setError("");
    readVersion.current++; setReading(false);
    try {
      if (next === "choose") {
        const result = await invoke<{ cancelled?: boolean; workspace?: Workspace }>("workspace_choose");
        if (mounted.current && !result.cancelled && result.workspace) adopt(result.workspace);
      } else {
        if (next === "close" && workspace) {
          setPreview(null);
          await invoke("workspace_close", { workspaceId: workspace.id });
        }
        const result = await invoke<{ workspace: Workspace | null }>("workspace_state");
        if (mounted.current) adopt(result.workspace);
      }
    } catch (cause) {
      if (mounted.current) setError(failure(cause));
      // A lost reply may have changed the grant. Reconcile with Node instead of trusting stale local state.
      try {
        const result = await invoke<{ workspace: Workspace | null }>("workspace_state");
        if (mounted.current) {
          adopt(result.workspace);
          if ((next === "choose" && result.workspace && result.workspace.id !== workspace?.id) ||
            (next === "close" && !result.workspace) || next === "reload") setError("");
        }
      } catch { /* The explicit reload action remains available. */ }
    } finally {
      working.current = false;
      if (mounted.current) setAction(null);
    }
  }
  async function read(item: Item) {
    if (!workspace || working.current) return;
    if (item.kind === "directory") {
      readVersion.current++; setReading(false); setReadError(""); setPreview(null); setPath(item.path);
      return;
    }
    if (!item.previewable) return;
    const version = ++readVersion.current;
    setReading(true); setPreview(null); setReadError("");
    try {
      const result = await invoke<Preview>("workspace_read", { input: { workspaceId: workspace.id, path: item.path } });
      if (mounted.current && version === readVersion.current && result.workspaceId === workspace.id && result.path === item.path) setPreview(result);
    } catch (cause) {
      if (mounted.current && version === readVersion.current) setReadError(failure(cause));
    } finally { if (mounted.current && version === readVersion.current) setReading(false); }
  }
  function go(path: string) {
    readVersion.current++; setReading(false); setPreview(null); setReadError(""); setPath(path);
  }
  const activeListing = listing?.workspaceId === workspace?.id && listing?.path === path ? listing : null;
  return <div className="file-workspace">
    <header className="file-workspace-heading">
      <div><h2>工作区</h2>{workspace && <span>{workspace.name} <small>只读</small></span>}</div>
      <div className="provider-actions">
        <button type="button" disabled={action !== null} onClick={() => void change("choose")}>{action === "choose" ? "选择中..." : workspace ? "切换目录" : "选择目录"}</button>
        <button type="button" disabled={action !== null} onClick={() => void change("reload")}>重新载入工作区</button>
        {workspace && <button type="button" disabled={action !== null} onClick={() => void change("close")}>关闭工作区</button>}
      </div>
    </header>
    {error && <p className="error" role="alert">{error}</p>}
    {!workspace ? <div className="file-workspace-empty"><StudioIcon name="workspace" /><p>{initializing ? "正在读取工作区..." : "选择一个工作目录"}</p></div> :
      <div className="file-workspace-body">
        <aside className="file-browser" aria-label="工作区文件">
          <nav className="file-breadcrumb" aria-label="目录位置">
            <button type="button" disabled={action !== null} onClick={() => go("")}>{workspace.name}</button>
            {path.split("/").filter(Boolean).map((part, index, all) => <button type="button" disabled={action !== null} key={index}
              onClick={() => go(all.slice(0, index + 1).join("/"))}>/ {part}</button>)}
          </nav>
          <input type="search" aria-label="筛选当前目录" placeholder="筛选文件..." value={query} onChange={event => setQuery(event.target.value)} />
          {loading && <p role="status">正在读取目录...</p>}
          {listError && <div className="error" role="alert">{listError}<button type="button" onClick={() => setRevision(value => value + 1)}>重试目录</button></div>}
          <div className="file-list">
            {activeListing?.items.filter(item => item.name.toLowerCase().includes(query.trim().toLowerCase())).map(item => <button key={item.path} type="button"
              className={preview?.path === item.path ? "selected" : ""} disabled={action !== null || (item.kind !== "directory" && !item.previewable)}
              title={item.kind === "blocked" ? "此路径不可访问" : !item.previewable && item.kind !== "directory" ? "暂不支持此文件类型" : item.name}
              onClick={() => void read(item)}><span aria-hidden="true">{item.kind === "directory" ? "▸" : "·"}</span><span>{item.name}</span></button>)}
          </div>
          {activeListing?.items.length === 0 && <p className="muted">目录为空。</p>}
          {activeListing?.truncated && <p className="muted">目录较大，仅显示部分文件（最多 200 项）。</p>}
        </aside>
        <section className="file-preview" aria-label="文件预览">
          {reading && <p role="status">正在读取文件...</p>}
          {readError && <p className="error" role="alert">{readError}</p>}
          {preview && <><header><strong>{preview.path}</strong><span>{preview.bytes.toLocaleString("zh-CN")} 字节</span><CopyButton text={preview.text} label="复制文件内容" /></header>
            <pre tabIndex={0} aria-label="文件内容">{preview.text || "（空文件）"}</pre></>}
          {!preview && !reading && !readError && <p className="muted">选择文件预览</p>}
        </section>
      </div>}
  </div>;
}
