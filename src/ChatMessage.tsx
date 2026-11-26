import { Children, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";

function CopyButton({ text, label }: { text: string; label: string }) {
  const mounted = useRef(false);
  const working = useRef(false);
  const [result, setResult] = useState<{ text: string; state: "pending" | "copied" | "error" } | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function copy() {
    if (working.current) return;
    working.current = true;
    setResult({ text, state: "pending" });
    try {
      await navigator.clipboard.writeText(text);
      if (mounted.current) setResult({ text, state: "copied" });
    } catch {
      if (mounted.current) setResult({ text, state: "error" });
    } finally { working.current = false; }
  }
  const state = result?.text === text ? result.state : null;
  return <span className="message-copy">
    <button type="button" disabled={state === "pending"} onClick={() => void copy()}>{label}</button>
    <span role="status">{state === "copied" ? "已复制" : state === "error" ? "复制失败，请手动选择文本复制。" : ""}</span>
  </span>;
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const child = Children.toArray(children)[0];
  const code = isValidElement<{ children?: ReactNode; className?: string }>(child) ? child : null;
  const text = typeof code?.props.children === "string" ? code.props.children : "";
  const language = /\blanguage-(\S+)/.exec(code?.props.className ?? "")?.[1] ?? "代码";
  const [collapsed, setCollapsed] = useState(false);
  const heading = useRef<HTMLDivElement>(null);
  const anchor = useRef<number | null>(null);
  const codeId = useId();
  const lines = text.replace(/\n$/, "").split("\n").length;
  useLayoutEffect(() => {
    if (anchor.current === null || !heading.current) return;
    const scroller = heading.current.closest(".transcript-list");
    if (scroller) scroller.scrollTop += heading.current.getBoundingClientRect().top - anchor.current;
    anchor.current = null;
  }, [collapsed]);
  return <div className="message-code" data-collapsed={collapsed}>
    <div className="message-code-heading" ref={heading}><span>{language}</span><div className="message-code-actions">
      {lines >= 48 && <button type="button" aria-expanded={!collapsed} aria-controls={codeId}
        onClick={() => { anchor.current = heading.current?.getBoundingClientRect().top ?? null; setCollapsed(value => !value); }}>
        {collapsed ? "展开代码" : "收起代码"} · {lines} 行
      </button>}
      <CopyButton text={text} label="复制代码" />
    </div></div>
    <pre id={codeId}>{children}</pre>
  </div>;
}

function MessageLink({ href, children }: { href?: string; children?: ReactNode }) {
  const [failed, setFailed] = useState(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  if (!href) return <>{children}</>;
  return <>
    <a href={href} title="在系统浏览器打开" onClick={(event) => {
      event.preventDefault();
      setFailed(false);
      void openUrl(href).catch(() => { if (mounted.current) setFailed(true); });
    }}>{children}</a>
    {failed && <span role="status">（链接打开失败）</span>}
  </>;
}

export default function ChatMessage({ text, markdown = false }: { text: string; markdown?: boolean }) {
  return <div className="chat-message">
    {markdown ? <div className="message-markdown">
      <Markdown remarkPlugins={[remarkGfm]} skipHtml
        urlTransform={(url) => /^https?:\/\//i.test(url) ? url : ""}
        components={{ pre: CodeBlock, a: MessageLink, img: ({ alt }) => <span className="muted">[图片：{alt || "未加载"}]</span> }}>
        {text}
      </Markdown>
    </div> : <pre className="transcript-content">{text}</pre>}
    <CopyButton text={text} label={markdown ? "复制回复" : "复制消息"} />
  </div>;
}
