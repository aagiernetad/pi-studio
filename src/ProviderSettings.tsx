import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import CustomProviderSettings from "./CustomProviderSettings";

type Provider = { id: string; name: string; supportsApiKey: boolean };
type Model = {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  supportsConnectionTest: boolean;
};
type CredentialStatus = { providerId: string; stored: boolean; type: "api_key" | "oauth" | null };

function errorMessage(cause: unknown): string {
  const text = typeof cause === "string" ? cause : cause instanceof Error ? cause.message : "";
  const code = /^([A-Z_]+):/.exec(text)?.[1];
  const messages: Record<string, string> = {
    INVALID_PARAMS: "输入无效，请检查服务商、模型和 API Key。",
    PROVIDER_NOT_FOUND: "服务商不存在，请刷新列表。",
    MODEL_NOT_FOUND: "模型不存在，请刷新后重新选择。",
    PROVIDER_NOT_CONFIGURED: "未找到可用凭据，请先保存 API Key。",
    PROVIDER_API_KEY_UNSUPPORTED: "该服务商暂不支持在这里设置 API Key。",
    PROVIDER_TEST_UNSUPPORTED: "该模型或认证方式暂不支持连接测试。",
    PROVIDER_TEST_TIMEOUT: "连接测试超时，请检查网络后重试。",
    REQUEST_CANCELLED: "操作已取消。",
    PROVIDER_TEST_FAILED: "连接失败，请检查 API Key、模型权限或网络。",
    CREDENTIAL_STORE_UNAVAILABLE: "无法访问系统凭据管理器，请稍后重试。",
    IPC_TIMEOUT: "请求超时，操作可能已经生效，请刷新状态确认。",
  };
  // 不展示未知原始错误，防止底层异常回显密钥。
  return (code && messages[code]) || "操作失败，请刷新状态后重试。";
}

function ProviderEditor({ provider, onBusy }: { provider: Provider; onBusy: (busy: boolean) => void }) {
  const [models, setModels] = useState<Model[]>([]);
  const [modelsError, setModelsError] = useState("");
  const [testError, setTestError] = useState("");
  const [modelId, setModelId] = useState("");
  const [credential, setCredential] = useState<CredentialStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<"save" | "delete" | "test" | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const password = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const running = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (password.current) password.current.value = "";
    };
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setNotice("");
    setCredential(null);
    setModels([]);
    setModelsError("");
    setTestError("");
    if (password.current) password.current.value = "";
    setHasKey(false);
    void Promise.allSettled([
      invoke<{ items: Model[] }>("model_list", { providerId: provider.id }),
      invoke<CredentialStatus>("provider_credential_status", { providerId: provider.id }),
    ]).then(([catalog, status]) => {
      if (!active) return;
      if (catalog.status === "fulfilled") {
        setModels(catalog.value.items);
        setModelId((current) => catalog.value.items.some((model) => model.id === current) ? current : (catalog.value.items[0]?.id ?? ""));
      } else {
        setModelId("");
        setModelsError("模型目录读取失败，可刷新状态重试。");
      }
      if (status.status === "fulfilled") setCredential(status.value);
      else setError(errorMessage(status.reason));
      setLoading(false);
    });
    return () => { active = false; };
  }, [provider.id, revision]);

  async function perform(next: "save" | "delete" | "test") {
    if (running.current || loading || !credential) return;
    if (next === "save" && !password.current?.value.trim()) return;
    running.current = true;
    setAction(next);
    onBusy(true);
    setError("");
    setTestError("");
    setNotice("");
    try {
      if (next === "save") {
        // 密钥只从非受控密码框取出并提交，不进入 React 状态或普通存储。
        const apiKey = password.current?.value.trim() ?? "";
        if (password.current) password.current.value = "";
        setHasKey(false);
        const status = await invoke<CredentialStatus>("provider_credential_set", { providerId: provider.id, apiKey });
        if (mounted.current) {
          setCredential(status);
          setNotice("API Key 已保存到 Windows 凭据管理器。");
        }
      } else if (next === "delete") {
        const status = await invoke<CredentialStatus>("provider_credential_delete", { providerId: provider.id });
        if (mounted.current) {
          setCredential(status);
          if (password.current) password.current.value = "";
          setHasKey(false);
          setNotice("已删除该服务商保存的凭据。");
        }
      } else {
        const result = await invoke<{ connected: boolean; durationMs: number }>("provider_test", { providerId: provider.id, modelId });
        if (mounted.current) setNotice(result.connected ? `连接成功，用时 ${result.durationMs} 毫秒。` : "连接未成功，请重试。");
      }
    } catch (cause: unknown) {
      if (mounted.current) {
        if (next === "test") setTestError(errorMessage(cause));
        else setError(errorMessage(cause));
        // 超时或失败后不能把旧状态当成实际结果，要求重新查询。
        if (next !== "test") setCredential(null);
      }
    } finally {
      running.current = false;
      onBusy(false);
      if (mounted.current) setAction(null);
    }
  }

  const selected = models.find((model) => model.id === modelId);
  const busy = action !== null;
  return (
    <div className="provider-editor" aria-busy={loading || busy}>
      {notice && <p className="provider-notice" role="status">{notice}</p>}
      <section className="provider-step" aria-labelledby="credential-heading">
      <h3 id="credential-heading">1. 保存访问凭据</h3>
      <div className="provider-status" role="status">
        {loading ? "正在读取服务商设置..." : credential ? (
          credential.stored ? `已保存${credential.type === "oauth" ? " OAuth 凭据" : " API Key"}` : "尚未保存 API Key"
        ) : "凭据状态待确认"}
        <button type="button" disabled={loading || busy} onClick={() => setRevision((value) => value + 1)}>刷新状态</button>
      </div>
      {provider.supportsApiKey ? (
        <form onSubmit={(event) => { event.preventDefault(); void perform("save"); }}>
          <label className="provider-field">
            <span>API Key</span>
            <input ref={password} type="password" autoComplete="off" spellCheck={false} maxLength={1024}
              disabled={loading || busy || !credential} placeholder={credential?.stored ? "输入新 Key 可替换已保存凭据" : "输入服务商提供的 API Key"}
              onInput={() => { setHasKey(Boolean(password.current?.value.trim())); setNotice(""); }} />
          </label>
          <p className="muted">密钥保存在 Windows 系统凭据管理器中，保存后不回填。</p>
          <div className="provider-actions">
            <button type="submit" className="primary" disabled={loading || busy || !credential || !hasKey}>{action === "save" ? "正在保存..." : "保存 API Key"}</button>
            <button type="button" disabled={loading || busy || !credential?.stored} onClick={() => void perform("delete")}>{action === "delete" ? "正在删除..." : "删除已保存凭据"}</button>
          </div>
        </form>
      ) : <p className="muted">该服务商需要 OAuth 或其他配置，当前设置面板仅支持 API Key。</p>}
      {error && <div className="error" role="alert">{error}</div>}
      </section>
      <section className="provider-step" aria-labelledby="connection-heading">
      <h3 id="connection-heading">2. 测试模型连接</h3>
      <p className="muted">保存密钥后，选择模型并测试。凭据已保存不代表连接已经通过测试。</p>
      <label className="provider-field">
        <span>用于测试的模型</span>
        <select aria-label="用于测试的模型" value={modelId} disabled={loading || busy || models.length === 0} onChange={(event) => { setModelId(event.target.value); setNotice(""); setTestError(""); }}>
          {models.length === 0 && <option value="">暂无可选模型</option>}
          {models.map((model) => <option key={model.id} value={model.id}>{model.name} · {model.id}</option>)}
        </select>
      </label>
      {selected && <p className="muted">上下文 {selected.contextWindow.toLocaleString()} token · 最大输出 {selected.maxTokens.toLocaleString()} token</p>}
      {!loading && modelsError && <div className="error" role="alert">{modelsError}</div>}
      {!loading && !modelsError && models.length === 0 && <p className="provider-empty" role="status">该服务商暂无模型。可刷新状态，或在“自定义配置”中添加兼容服务商。</p>}
      <div className="provider-test-row">
        <button type="button" disabled={loading || busy || hasKey || !selected?.supportsConnectionTest || !credential?.stored || credential.type !== "api_key"}
          onClick={() => void perform("test")}>{action === "test" ? "正在测试连接..." : "测试连接"}</button>
        <span className="muted">会发送一个简短模型请求，可能产生少量费用。</span>
      </div>
      {testError && <div className="error" role="alert">{testError}</div>}
      {hasKey && <p className="muted">请先保存新 Key，再测试连接。</p>}
      {selected && !selected.supportsConnectionTest && <p className="muted">该模型接口暂不支持连接测试。</p>}
      </section>
    </div>
  );
}

export default function ProviderSettings({ onBusyChange }: { onBusyChange?: (busy: boolean) => void }) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providerId, setProviderId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [managing, setManaging] = useState(false);
  const [configNotice, setConfigNotice] = useState("");
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void invoke<{ items: Provider[] }>("provider_list").then((catalog) => {
      if (!active) return;
      setProviders(catalog.items);
      setProviderId((current) => catalog.items.some((provider) => provider.id === current) ? current :
        (catalog.items.find((provider) => provider.id === "deepseek")?.id ?? catalog.items[0]?.id ?? ""));
    }).catch((cause: unknown) => {
      if (active) setError(errorMessage(cause));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision]);
  function handleBusy(next: boolean) { setBusy(next); onBusyChange?.(next); }
  const provider = providers.find((item) => item.id === providerId);
  return (
    <section className="panel provider-settings" aria-labelledby="provider-heading">
      <h3 id="provider-heading">服务商设置</h3>
        <p className="muted">管理服务商密钥并检查模型连接。</p>
        <div className="provider-actions provider-mode-picker" role="group" aria-label="设置操作">
          <button type="button" disabled={busy} aria-pressed={!managing} onClick={() => setManaging(false)}>密钥与连接</button>
          <button type="button" disabled={busy} aria-pressed={managing} onClick={() => { setManaging(true); setConfigNotice(""); }}>自定义配置</button>
        </div>
        {configNotice && <p className="provider-notice" role="status">{configNotice}</p>}
        {!managing && <>
        <div className="section-heading">
          <label className="provider-field provider-picker"><span>服务商</span>
            <select aria-label="服务商" value={providerId} disabled={loading || busy || Boolean(error) || providers.length === 0} onChange={(event) => setProviderId(event.target.value)}>
              {providers.length === 0 && <option value="">暂无服务商</option>}
              {providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <button type="button" disabled={loading || busy} onClick={() => setRevision((value) => value + 1)}>刷新服务商</button>
        </div>
        {loading && <p className="muted">正在读取服务商列表...</p>}
        {error && <div className="error" role="alert">{error}
          <button type="button" disabled={loading || busy} onClick={() => setRevision((value) => value + 1)}>重试读取服务商</button>
        </div>}
        {!loading && !error && providers.length === 0 && <div className="provider-empty" role="status">
          <p>暂无可用服务商。可以刷新目录，或添加自定义服务商。</p>
          <button type="button" onClick={() => { setManaging(true); setConfigNotice(""); }}>添加自定义服务商</button>
        </div>}
        {!loading && !error && provider && <ProviderEditor key={provider.id} provider={provider} onBusy={handleBusy} />}
        </>}
        {managing && <CustomProviderSettings onBusy={handleBusy} onSaved={(id) => {
          setProviderId(id ?? "deepseek");
          setRevision((value) => value + 1);
          setManaging(false);
          setConfigNotice(id ? "配置已保存，可设置 API Key 并测试连接。" : "配置已删除，系统凭据保持不变。");
        }} />}
    </section>
  );
}
