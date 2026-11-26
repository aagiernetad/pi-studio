import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Config = {
  id: string; name: string; baseUrl: string; modelId: string;
  contextWindow: number; maxTokens: number;
};
const empty: Config = { id: "custom-", name: "", baseUrl: "", modelId: "", contextWindow: 32768, maxTokens: 4096 };

export default function CustomProviderSettings({ onSaved, onBusy }: {
  onSaved: (id: string | null) => void; onBusy: (busy: boolean) => void;
}) {
  const [items, setItems] = useState<Config[]>([]);
  const [selected, setSelected] = useState("");
  const [form, setForm] = useState<Config>(empty);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState(false);
  const [revision, setRevision] = useState(0);
  const mounted = useRef(false);
  const running = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setLoadError(false);
    void invoke<{ items: Config[] }>("provider_config_list").then((result) => {
      if (active) setItems(result.items);
    }).catch(() => {
      if (active) { setLoadError(true); setError("配置读取失败，请刷新配置后重试。"); }
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision]);

  async function save(remove = false) {
    if (running.current || loading || loadError) return;
    running.current = true;
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      if (remove) {
        await invoke("provider_config_delete", { providerId: selected });
        if (mounted.current) onSaved(null);
      } else {
        const result = await invoke<Config>("provider_config_set", { config: form });
        if (mounted.current) onSaved(result.id);
      }
    } catch (cause: unknown) {
      if (mounted.current) {
        const invalid = typeof cause === "string" && cause.startsWith("INVALID_PARAMS:");
        setError(invalid ? "配置无效，请检查标识、地址和模型参数。" : "操作失败，结果可能已生效，请刷新配置确认。");
        if (!invalid) setLoadError(true);
      }
    } finally {
      running.current = false;
      onBusy(false);
      if (mounted.current) setBusy(false);
    }
  }

  function choose(id: string) {
    setSelected(id);
    setForm(items.find((item) => item.id === id) ?? { ...empty });
    setError("");
  }
  return (
    <div className="provider-editor" aria-busy={busy || loading}>
      <h3>自定义服务商配置</h3>
      <p className="muted">OpenAI 兼容 Chat Completions 接口；每个配置先支持一个文本模型。</p>
      <button type="button" disabled={busy || loading} onClick={() => { choose(""); setRevision((value) => value + 1); }}>刷新配置</button>
      {loading && <p className="muted" role="status">正在读取自定义配置...</p>}
      {!loading && !loadError && items.length === 0 && <p className="provider-empty" role="status">尚未添加自定义服务商，可填写下方表单。内置服务商可直接在“密钥与连接”中使用。</p>}
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <fieldset className="provider-config-fields provider-config-grid" disabled={busy || loading || loadError}>
          <label className="provider-field"><span>编辑配置</span>
            <select aria-label="编辑配置" value={selected} onChange={(event) => choose(event.target.value)}>
              <option value="">新建自定义服务商</option>
              {items.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}
            </select>
          </label>
          <label className="provider-field"><span>配置标识</span>
            <input required aria-label="配置标识" value={form.id} readOnly={Boolean(selected)} maxLength={63}
              pattern="custom-[a-z0-9][a-z0-9-]{0,55}" onChange={(event) => setForm({ ...form, id: event.target.value })} />
          </label>
          <p className="muted">以 custom- 开头，只使用小写字母、数字和连字符；不会覆盖内置服务商。保存会更新相同标识的配置。</p>
          <label className="provider-field"><span>显示名称</span>
            <input required aria-label="显示名称" maxLength={80} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </label>
          <label className="provider-field"><span>API 基础地址</span>
            <input required type="url" aria-label="API 基础地址" maxLength={2048} placeholder="https://example.com/v1" value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} />
          </label>
          <p className="muted">填写基础地址，不含 /chat/completions、认证信息或查询参数。远程地址使用 HTTPS，本机回环地址允许 HTTP。</p>
          <label className="provider-field"><span>模型 ID</span>
            <input required aria-label="模型 ID" maxLength={256} value={form.modelId} onChange={(event) => setForm({ ...form, modelId: event.target.value })} />
          </label>
          <label className="provider-field"><span>上下文窗口</span>
            <input required type="number" aria-label="上下文窗口" min={128} max={10000000} step={1} value={form.contextWindow} onChange={(event) => setForm({ ...form, contextWindow: Number(event.target.value) })} />
          </label>
          <label className="provider-field"><span>最大输出 token</span>
            <input required type="number" aria-label="最大输出 token" min={16} max={Math.min(form.contextWindow, 1000000)} step={1} value={form.maxTokens} onChange={(event) => setForm({ ...form, maxTokens: Number(event.target.value) })} />
          </label>
          <p className="muted">配置不保存密钥。保存后到“密钥与连接”设置 API Key。修改地址后，连接测试会向新地址发送该标识已保存的 Key。</p>
          <div className="provider-actions">
            <button type="submit" className="primary">{busy ? "正在处理..." : "保存配置"}</button>
            {selected && <button type="button" onClick={() => void save(true)}>删除配置（保留凭据）</button>}
          </div>
          {selected && <p className="muted">如需清除密钥，请先在“密钥与连接”中删除凭据，再删除配置。</p>}
        </fieldset>
      </form>
      {error && <div className="error" role="alert">{error}
        {loadError && <button type="button" disabled={busy || loading} onClick={() => { choose(""); setRevision((value) => value + 1); }}>重试读取配置</button>}
      </div>}
    </div>
  );
}
