import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { appearanceBackup, DEFAULT_APPEARANCE, parseAppearanceBackup, type Appearance, type ThemeMode } from "./appearance";

type Props = {
  value: Appearance; mode: ThemeMode; theme: "dark" | "light";
  onChange: (value: Appearance) => void; onModeChange: (mode: ThemeMode) => void;
};
const themes = [
  { id: "obsidian", name: "深空黑曜", mode: "dark" },
  { id: "warm", name: "暖炭玄岩", mode: "dark" },
  { id: "crystal", name: "白昼冷晶", mode: "light" },
  { id: "alabaster", name: "暖白画册", mode: "light" },
] as const;
export default function AppearanceSettings({ value, mode, theme, onChange, onModeChange }: Props) {
  const [notice, setNotice] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const importGeneration = useRef(0);
  useEffect(() => () => { importGeneration.current += 1; }, []);
  function apply(next: Appearance) { importGeneration.current += 1; setNotice(""); onChange(next); }
  function change<K extends keyof Appearance>(key: K, next: Appearance[K]) {
    importGeneration.current += 1;
    setNotice("");
    onChange({ ...value, [key]: next });
  }
  const selected = theme === "dark" ? value.darkPalette : value.lightPalette;
  async function importFile(selectedFile: File | undefined) {
    if (!selectedFile) return;
    const generation = ++importGeneration.current;
    try {
      if (selectedFile.size > 16384) throw new Error("too large");
      const backup = parseAppearanceBackup(await selectedFile.text());
      if (generation !== importGeneration.current) return;
      onChange(backup.appearance);
      onModeChange(backup.mode);
      setNotice("外观已导入。");
    } catch { if (generation === importGeneration.current) setNotice("配置文件无效，未修改外观。"); }
  }
  function exportFile() {
    const url = URL.createObjectURL(new Blob([appearanceBackup(value, mode)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = "pi-studio-appearance.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="appearance-settings">
    <div className="appearance-mode" role="group" aria-label="明暗模式">
      {([["system", "跟随系统"], ["light", "浅色"], ["dark", "深色"]] as const).map(([key, label]) =>
        <button type="button" key={key} aria-pressed={mode === key} onClick={() => { importGeneration.current += 1; onModeChange(key); }}>{label}</button>)}
    </div>
    <section aria-labelledby="palette-heading">
      <h3 id="palette-heading">主题</h3>
      <div className="theme-gallery">
        {themes.map(item => <button type="button" className="theme-card" key={item.id}
          data-preset={item.id} aria-pressed={selected === item.id}
          onClick={() => {
            if (item.mode === "dark") change("darkPalette", item.id);
            else change("lightPalette", item.id);
            onModeChange(item.mode);
          }}>
          <span className="theme-miniature" aria-hidden="true"><span className="mini-sidebar"><i /><i /><i /></span>
            <span className="mini-canvas"><i /><i /><i /><b /></span></span>
          <span>{item.name}</span><span className="theme-check" aria-hidden="true">{selected === item.id ? "✓" : ""}</span>
        </button>)}
      </div>
    </section>
    <section aria-labelledby="style-heading">
      <h3 id="style-heading">界面</h3>
      <div className="appearance-grid">
        <label className="provider-field"><span>强调色</span><select aria-label="强调色" value={value.accent} onChange={event => change("accent", event.target.value as Appearance["accent"])}>
          <option value="theme">跟随主题</option><option value="cobalt">钴蓝</option><option value="iris">鸢尾紫</option><option value="amber">琥珀金</option><option value="mono">纯银钛</option>
        </select></label>
        <label className="provider-field"><span>圆角</span><select aria-label="圆角" value={value.corners} onChange={event => change("corners", event.target.value as Appearance["corners"])}>
          <option value="sharp">利落</option><option value="balanced">均衡</option><option value="soft">柔和</option>
        </select></label>
        <label className="provider-field"><span>侧栏密度</span><select aria-label="侧栏密度" value={value.density} onChange={event => change("density", event.target.value as Appearance["density"])}>
          <option value="comfortable">舒适</option><option value="compact">紧凑</option>
        </select></label>
        <label className="provider-field"><span>阅读宽度</span><select aria-label="阅读宽度" value={value.width} onChange={event => change("width", event.target.value as Appearance["width"])}>
          <option value="focused">专注</option><option value="wide">宽屏</option>
        </select></label>
        <label className="provider-field"><span>代码字体</span><select aria-label="代码字体" value={value.codeFont} onChange={event => change("codeFont", event.target.value as Appearance["codeFont"])}>
          <option value="default">系统等宽</option><option value="jetbrains">JetBrains Mono</option><option value="cascadia">Cascadia Code</option><option value="sfmono">SF Mono</option>
        </select></label>
        <label className="appearance-checkbox"><input type="checkbox" checked={value.ligatures} onChange={event => change("ligatures", event.target.checked)} />代码连字</label>
      </div>
    </section>
    <section aria-labelledby="motion-heading">
      <h3 id="motion-heading">动效</h3>
      <div className="scene-presets" role="group" aria-label="场景预设">
        <button type="button" onClick={() => apply({ ...value, ambient: "full", motion: "standard", density: "comfortable" })}>光学效果</button>
        <button type="button" onClick={() => onChange({ ...value, ambient: "subtle", motion: "standard", density: "compact", width: "focused" })}>专注阅读</button>
        <button type="button" onClick={() => onChange({ ...value, ambient: "off", motion: "off" })}>静默省电</button>
      </div>
      <div className="appearance-grid">
        <label className="provider-field"><span>环境光</span><select aria-label="环境光" value={value.ambient} onChange={event => change("ambient", event.target.value as Appearance["ambient"])}>
          <option value="off">关闭</option><option value="subtle">柔和</option><option value="full">完整</option>
        </select></label>
        <label className="provider-field"><span>界面过渡</span><select aria-label="界面过渡" value={value.motion} onChange={event => change("motion", event.target.value as Appearance["motion"])}>
          <option value="standard">开启</option><option value="off">关闭</option>
        </select></label>
        <label className="provider-field"><span>回到最新</span><select aria-label="回到最新滚动" value={value.scroll} onChange={event => change("scroll", event.target.value as Appearance["scroll"])}>
          <option value="instant">立即定位</option><option value="smooth">平滑滚动</option>
        </select></label>
      </div>
    </section>
    <section className="appearance-backup" aria-label="外观配置">
      <div className="provider-actions">
        <button type="button" onClick={exportFile}>导出外观</button>
        <button type="button" onClick={() => file.current?.click()}>导入外观</button>
        <input className="sr-only" ref={file} type="file" accept=".json,application/json" aria-label="导入外观文件"
          onChange={event => { void importFile(event.target.files?.[0]); event.target.value = ""; }} />
        <button type="button" onClick={() => { importGeneration.current += 1; onChange({ ...DEFAULT_APPEARANCE }); onModeChange("system"); setNotice("已恢复默认外观。"); }}>恢复默认</button>
      </div>
      {notice && <p role="status" className="muted">{notice}</p>}
      <a className="design-credit" href="https://github.com/RMvdesi/obsidian-prism" onClick={event => { event.preventDefault(); void openUrl("https://github.com/RMvdesi/obsidian-prism").catch(() => setNotice("链接打开失败。")); }}>设计参考 · Obsidian Prism / RMvdesi</a>
    </section>
  </div>;
}
