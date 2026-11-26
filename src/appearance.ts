export type Appearance = {
  darkPalette: "obsidian" | "warm";
  lightPalette: "crystal" | "alabaster";
  accent: "theme" | "cobalt" | "iris" | "amber" | "mono";
  corners: "sharp" | "balanced" | "soft";
  codeFont: "default" | "jetbrains" | "cascadia" | "sfmono";
  density: "comfortable" | "compact";
  motion: "standard" | "off";
  ambient: "off" | "subtle" | "full";
  width: "focused" | "wide";
  ligatures: boolean;
  scroll: "instant" | "smooth";
};
export type ThemeMode = "system" | "light" | "dark";
export const APPEARANCE_KEY = "pi-studio.appearance";
export const DEFAULT_APPEARANCE: Appearance = {
  darkPalette: "obsidian", lightPalette: "crystal", accent: "theme", corners: "balanced",
  codeFont: "default", density: "comfortable", motion: "standard", ambient: "subtle",
  width: "focused", ligatures: false, scroll: "instant",
};
const options = {
  darkPalette: ["obsidian", "warm"], lightPalette: ["crystal", "alabaster"],
  accent: ["theme", "cobalt", "iris", "amber", "mono"], corners: ["sharp", "balanced", "soft"],
  codeFont: ["default", "jetbrains", "cascadia", "sfmono"], density: ["comfortable", "compact"],
  motion: ["standard", "off"], ambient: ["off", "subtle", "full"], width: ["focused", "wide"],
  scroll: ["instant", "smooth"],
};
export function validAppearance(value: unknown): value is Appearance {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(DEFAULT_APPEARANCE);
  if (Object.keys(record).length !== keys.length || !keys.every(key => Object.prototype.hasOwnProperty.call(record, key))) return false;
  return Object.entries(options).every(([key, values]) => typeof record[key] === "string" && (values as readonly string[]).includes(record[key] as string))
    && typeof record.ligatures === "boolean";
}
export function loadAppearance(): Appearance {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(APPEARANCE_KEY) ?? "null");
    return validAppearance(value) ? value : { ...DEFAULT_APPEARANCE };
  } catch { return { ...DEFAULT_APPEARANCE }; }
}
export function appearanceBackup(value: Appearance, mode: ThemeMode): string {
  return JSON.stringify({ version: 1, mode, appearance: value }, null, 2);
}
export function parseAppearanceBackup(text: string): { mode: ThemeMode; appearance: Appearance } {
  if (text.length > 16384) throw new Error("invalid appearance");
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid appearance");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 3 || record.version !== 1 ||
    !["system", "light", "dark"].includes(String(record.mode)) || !validAppearance(record.appearance)) throw new Error("invalid appearance");
  return { mode: record.mode as ThemeMode, appearance: record.appearance };
}
