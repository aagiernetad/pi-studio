import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Conversation = { id: number; title: string; createdAt: number };

export default function ConversationTitleEditor({ conversation, onRenamed, disabled, onSavingChange }: {
  conversation: Conversation; onRenamed: (conversation: Conversation) => void;
  disabled: boolean; onSavingChange: (saving: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(conversation.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const working = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; onSavingChange(false); }; }, [onSavingChange]);

  async function save() {
    if (working.current || disabled || !title.trim()) return;
    working.current = true;
    setSaving(true);
    onSavingChange(true);
    setError("");
    try {
      const result = await invoke<{ conversation: Conversation }>("conversation_rename", {
        conversationId: conversation.id, title: title.trim(),
      });
      if (mounted.current) { setEditing(false); onRenamed(result.conversation); }
    } catch {
      if (mounted.current) setError("标题保存结果尚未确认，可重试相同标题，或刷新列表核对。");
    } finally {
      working.current = false;
      if (mounted.current) { setSaving(false); onSavingChange(false); }
    }
  }

  return <div className="conversation-title-editor">
    <div className="transcript-heading"><h3>{conversation.title}</h3>
      {!editing && <button type="button" disabled={disabled} onClick={() => { setTitle(conversation.title); setError(""); setEditing(true); }}>重命名</button>}
    </div>
    {editing && <form className="conversation-create" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <input aria-label="新的会话标题" value={title} maxLength={120} disabled={saving || disabled}
        onChange={(event) => setTitle(event.target.value)} autoFocus />
      <button type="submit" disabled={saving || disabled || !title.trim()}>{saving ? "保存中..." : "保存标题"}</button>
      <button type="button" disabled={saving} onClick={() => { setEditing(false); setError(""); }}>取消</button>
    </form>}
    {error && <div className="error" role="alert">{error}</div>}
  </div>;
}
