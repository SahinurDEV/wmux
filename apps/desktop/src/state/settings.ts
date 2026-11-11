// Application settings: schema, defaults and (de)serialization to the flat
// key/value `settings` table.

export type ThemeMode = "dark" | "light" | "system";
export type CursorStyle = "block" | "bar" | "underline";

export interface CustomProfileSetting {
  id: string;
  name: string;
  program: string;
  args: string[];
}

export interface Settings {
  theme: ThemeMode;
  accent: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  scrollback: number;
  defaultShellProfileId: string | null;
  shellIntegration: boolean;
  copyOnSelect: boolean;
  gpuRendering: boolean;
  confirmCloseWorkspace: boolean;
  customProfiles: CustomProfileSetting[];
  /** commandId -> accelerator string, overriding defaults ("" = unbound). */
  keybindings: Record<string, string>;
}

export const ACCENTS = ["#7c8cff", "#5eead4", "#f472b6", "#fbbf24", "#60a5fa", "#a3e635", "#fb7185", "#c084fc"];

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  accent: "#7c8cff",
  fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace',
  fontSize: 13,
  lineHeight: 1.15,
  cursorStyle: "bar",
  cursorBlink: true,
  scrollback: 10000,
  defaultShellProfileId: null,
  shellIntegration: true,
  copyOnSelect: false,
  gpuRendering: true,
  confirmCloseWorkspace: true,
  customProfiles: [],
  keybindings: {},
};

/** Map of Settings fields to persisted keys. */
const KEYS: Record<keyof Settings, string> = {
  theme: "appearance.theme",
  accent: "appearance.accent",
  fontFamily: "terminal.fontFamily",
  fontSize: "terminal.fontSize",
  lineHeight: "terminal.lineHeight",
  cursorStyle: "terminal.cursorStyle",
  cursorBlink: "terminal.cursorBlink",
  scrollback: "terminal.scrollback",
  defaultShellProfileId: "terminal.defaultShellProfileId",
  shellIntegration: "terminal.shellIntegration",
  copyOnSelect: "terminal.copyOnSelect",
  gpuRendering: "terminal.gpuRendering",
  confirmCloseWorkspace: "general.confirmCloseWorkspace",
  customProfiles: "terminal.customProfiles",
  keybindings: "keyboard.bindings",
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Merge persisted values over defaults, validating every field. */
export function settingsFromStore(raw: Record<string, unknown>): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS };
  const get = (k: keyof Settings) => raw[KEYS[k]];
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);

  const theme = str(get("theme"));
  if (theme === "dark" || theme === "light" || theme === "system") s.theme = theme;
  const accent = str(get("accent"));
  if (accent && /^#[0-9a-f]{6}$/i.test(accent)) s.accent = accent;
  s.fontFamily = str(get("fontFamily"))?.slice(0, 300) || s.fontFamily;
  s.fontSize = clamp(num(get("fontSize")) ?? s.fontSize, 8, 32);
  s.lineHeight = clamp(num(get("lineHeight")) ?? s.lineHeight, 1, 2);
  const cursor = str(get("cursorStyle"));
  if (cursor === "block" || cursor === "bar" || cursor === "underline") s.cursorStyle = cursor;
  s.cursorBlink = bool(get("cursorBlink")) ?? s.cursorBlink;
  s.scrollback = clamp(Math.round(num(get("scrollback")) ?? s.scrollback), 500, 200000);
  const dsp = get("defaultShellProfileId");
  s.defaultShellProfileId = typeof dsp === "string" ? dsp : null;
  s.shellIntegration = bool(get("shellIntegration")) ?? s.shellIntegration;
  s.copyOnSelect = bool(get("copyOnSelect")) ?? s.copyOnSelect;
  s.gpuRendering = bool(get("gpuRendering")) ?? s.gpuRendering;
  s.confirmCloseWorkspace = bool(get("confirmCloseWorkspace")) ?? s.confirmCloseWorkspace;
  const cp = get("customProfiles");
  if (Array.isArray(cp)) {
    s.customProfiles = cp
      .filter((p): p is CustomProfileSetting =>
        !!p && typeof p === "object" && typeof p.id === "string" && typeof p.name === "string" && typeof p.program === "string",
      )
      .map((p) => ({ ...p, args: Array.isArray(p.args) ? p.args.filter((a) => typeof a === "string") : [] }));
  }
  const kb = get("keybindings");
  if (kb && typeof kb === "object" && !Array.isArray(kb)) {
    s.keybindings = Object.fromEntries(
      Object.entries(kb as Record<string, unknown>).filter(([, v]) => typeof v === "string"),
    ) as Record<string, string>;
  }
  return s;
}

export function settingsToStore(patch: Partial<Settings>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    const key = KEYS[k as keyof Settings];
    if (key) out[key] = v;
  }
  return out;
}
