import { useState, type ReactNode } from "react";
import { DatabaseBackup, Keyboard, Monitor, Moon, Palette, Plus, Settings2, SquareTerminal, Sun, Trash2, Wrench } from "lucide-react";
import { backupDatabase, updateSettings } from "../state/actions";
import { bindableCommands, effectiveBindings, eventToAccelerator } from "../state/commands";
import { ACCENTS, DEFAULT_SETTINGS, type CustomProfileSetting } from "../state/settings";
import { newId } from "../state/layout";
import { useStore } from "../state/store";
import { Button, Kbd, Modal, Toggle, cx, inputClass } from "./ui";

const TABS = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "keyboard", label: "Keyboard", icon: Keyboard },
  { id: "advanced", label: "Advanced", icon: Wrench },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function SettingsDialog({ initialTab }: { initialTab?: string }) {
  const [tab, setTab] = useState<TabId>((TABS.find((t) => t.id === initialTab)?.id ?? "general") as TabId);
  const close = () => useStore.getState().setOverlay(null);
  return (
    <Modal title="Settings" onClose={close} width={760}>
      <div className="flex min-h-[460px]">
        <nav className="w-44 shrink-0 border-r border-line p-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cx(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
                tab === t.id ? "bg-active text-fg" : "text-muted hover:bg-hover hover:text-fg",
              )}
            >
              <t.icon size={14} />
              {t.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto p-5">
          {tab === "general" && <GeneralTab />}
          {tab === "appearance" && <AppearanceTab />}
          {tab === "terminal" && <TerminalTab />}
          {tab === "keyboard" && <KeyboardTab />}
          {tab === "advanced" && <AdvancedTab />}
        </div>
      </div>
    </Modal>
  );
}

function Row({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-line py-3 last:border-0">
      <div className="min-w-0">
        <div className="text-[13px]">{label}</div>
        {description && <div className="mt-0.5 text-xs text-muted">{description}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function GeneralTab() {
  const s = useStore((x) => x.settings);
  return (
    <>
      <Row label="Confirm before closing a workspace" description="Closing a workspace stops all of its terminal processes.">
        <Toggle label="Confirm close" checked={s.confirmCloseWorkspace} onChange={(v) => void updateSettings({ confirmCloseWorkspace: v })} />
      </Row>
      <p className="mt-4 text-xs text-muted">
        Wmux restores your workspaces, layouts, tabs and working directories on startup. Processes cannot survive an app
        restart or Windows shutdown; restored terminals start new shell sessions and say so.
      </p>
    </>
  );
}

function AppearanceTab() {
  const s = useStore((x) => x.settings);
  const themes = [
    { id: "dark", label: "Dark", icon: Moon },
    { id: "light", label: "Light", icon: Sun },
    { id: "system", label: "System", icon: Monitor },
  ] as const;
  return (
    <>
      <Row label="Theme">
        <div className="flex gap-1 rounded-lg border border-line p-0.5">
          {themes.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => void updateSettings({ theme: t.id })}
              className={cx("flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs", s.theme === t.id ? "bg-active text-fg" : "text-muted hover:text-fg")}
            >
              <t.icon size={13} /> {t.label}
            </button>
          ))}
        </div>
      </Row>
      <Row label="Accent color">
        <div className="flex gap-1.5">
          {ACCENTS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Accent ${c}`}
              onClick={() => void updateSettings({ accent: c })}
              className={cx("h-5 w-5 rounded-full", s.accent === c && "ring-2 ring-fg/60 ring-offset-2 ring-offset-elev")}
              style={{ background: c }}
            />
          ))}
        </div>
      </Row>
      <Row label="Terminal font family" description="CSS font list; the first installed font is used.">
        <input
          className={cx(inputClass, "w-72 font-mono text-xs")}
          defaultValue={s.fontFamily}
          onBlur={(e) => void updateSettings({ fontFamily: e.target.value.trim() || DEFAULT_SETTINGS.fontFamily })}
        />
      </Row>
      <Row label="Terminal font size" description="Ctrl+= / Ctrl+- / Ctrl+0">
        <NumberInput value={s.fontSize} min={8} max={32} onChange={(v) => void updateSettings({ fontSize: v })} />
      </Row>
      <Row label="Line height">
        <NumberInput value={s.lineHeight} min={1} max={2} step={0.05} onChange={(v) => void updateSettings({ lineHeight: v })} />
      </Row>
    </>
  );
}

function TerminalTab() {
  const s = useStore((x) => x.settings);
  const profiles = useStore((x) => x.profiles);
  return (
    <>
      <Row label="Default shell" description="Used for new terminals unless a workspace overrides it.">
        <select
          className={cx(inputClass, "w-56")}
          value={s.defaultShellProfileId ?? ""}
          onChange={(e) => void updateSettings({ defaultShellProfileId: e.target.value || null })}
        >
          <option value="">Automatic ({profiles[0]?.name ?? "none found"})</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Row>
      <Row
        label="Shell integration"
        description="Lets PowerShell and cmd report the current directory so splits, the status bar and restore use it. Your own prompt is kept."
      >
        <Toggle label="Shell integration" checked={s.shellIntegration} onChange={(v) => void updateSettings({ shellIntegration: v })} />
      </Row>
      <Row label="Cursor style">
        <select className={cx(inputClass, "w-32")} value={s.cursorStyle} onChange={(e) => void updateSettings({ cursorStyle: e.target.value as typeof s.cursorStyle })}>
          <option value="bar">Bar</option>
          <option value="block">Block</option>
          <option value="underline">Underline</option>
        </select>
      </Row>
      <Row label="Blinking cursor">
        <Toggle label="Blinking cursor" checked={s.cursorBlink} onChange={(v) => void updateSettings({ cursorBlink: v })} />
      </Row>
      <Row label="Scrollback lines">
        <NumberInput value={s.scrollback} min={500} max={200000} step={500} onChange={(v) => void updateSettings({ scrollback: v })} />
      </Row>
      <Row label="Copy on select">
        <Toggle label="Copy on select" checked={s.copyOnSelect} onChange={(v) => void updateSettings({ copyOnSelect: v })} />
      </Row>
      <Row label="GPU-accelerated rendering" description="Uses WebGL. Turn off if you see rendering glitches.">
        <Toggle label="GPU rendering" checked={s.gpuRendering} onChange={(v) => void updateSettings({ gpuRendering: v })} />
      </Row>
      <CustomProfiles profiles={s.customProfiles} />
      <div className="mt-4">
        <div className="mb-2 text-xs font-semibold text-muted">Detected shells</div>
        <div className="space-y-1">
          {profiles.map((p) => (
            <div key={p.id} className="flex items-center gap-3 rounded-md bg-surface px-2 py-1.5 text-xs">
              <span className="w-36 shrink-0">{p.name}</span>
              <span className="truncate font-mono text-faint" title={p.program}>
                {p.program} {p.args.join(" ")}
              </span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function CustomProfiles({ profiles }: { profiles: CustomProfileSetting[] }) {
  const [draft, setDraft] = useState({ name: "", program: "", args: "" });
  const add = () => {
    if (!draft.name.trim() || !draft.program.trim()) return;
    const args = draft.args.match(/"[^"]*"|\S+/g)?.map((a) => a.replace(/^"|"$/g, "")) ?? [];
    void updateSettings({
      customProfiles: [...profiles, { id: newId().slice(0, 8), name: draft.name.trim(), program: draft.program.trim(), args }],
    });
    setDraft({ name: "", program: "", args: "" });
  };
  return (
    <div className="mt-4">
      <div className="mb-2 text-xs font-semibold text-muted">Custom shell profiles</div>
      {profiles.map((p) => (
        <div key={p.id} className="mb-1 flex items-center gap-2 rounded-md bg-surface px-2 py-1.5 text-xs">
          <span className="w-32 shrink-0 truncate">{p.name}</span>
          <span className="flex-1 truncate font-mono text-faint">
            {p.program} {p.args.join(" ")}
          </span>
          <button
            type="button"
            aria-label={`Remove ${p.name}`}
            onClick={() => void updateSettings({ customProfiles: profiles.filter((x) => x.id !== p.id) })}
            className="text-muted hover:text-danger"
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      <div className="mt-2 flex gap-2">
        <input className={cx(inputClass, "w-32")} placeholder="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <input className={cx(inputClass, "flex-1 font-mono text-xs")} placeholder="C:\path\to\shell.exe" value={draft.program} onChange={(e) => setDraft({ ...draft, program: e.target.value })} />
        <input className={cx(inputClass, "w-36 font-mono text-xs")} placeholder="arguments" value={draft.args} onChange={(e) => setDraft({ ...draft, args: e.target.value })} />
        <Button onClick={add} disabled={!draft.name.trim() || !draft.program.trim()}>
          <Plus size={13} className="inline" /> Add
        </Button>
      </div>
    </div>
  );
}

function KeyboardTab() {
  const overrides = useStore((x) => x.settings.keybindings);
  const bindings = effectiveBindings(overrides);
  const [recording, setRecording] = useState<string | null>(null);

  const setBinding = (id: string, acc: string | null) => {
    const next = { ...overrides };
    const def = bindableCommands.find((c) => c.id === id)?.defaultKey ?? "";
    if (acc === null || acc === def) delete next[id];
    else next[id] = acc;
    void updateSettings({ keybindings: next });
  };

  const conflictOf = (id: string, acc: string | undefined) =>
    acc ? [...bindings.entries()].find(([other, a]) => other !== id && a === acc)?.[0] : undefined;

  return (
    <>
      <p className="mb-3 text-xs text-muted">
        Click a shortcut to record a new one; press Escape to cancel or Backspace to unbind. Plain Ctrl+letter shortcuts are
        best left to the shell (Ctrl+C, Ctrl+D, Ctrl+R…).
      </p>
      {bindableCommands.map((c) => {
        const acc = bindings.get(c.id);
        const conflict = conflictOf(c.id, acc);
        return (
          <div key={c.id} className="flex items-center gap-3 border-b border-line py-1.5 last:border-0">
            <span className="flex-1 text-[13px]">
              {c.title}
              {conflict && <span className="ml-2 text-xs text-warning">conflicts with {bindableCommands.find((x) => x.id === conflict)?.title}</span>}
            </span>
            {recording === c.id ? (
              <input
                autoFocus
                readOnly
                aria-label={`Record shortcut for ${c.title}`}
                placeholder="Press keys…"
                onBlur={() => setRecording(null)}
                onKeyDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (e.key === "Escape") return setRecording(null);
                  if (e.key === "Backspace" && !e.ctrlKey && !e.altKey) {
                    setBinding(c.id, "");
                    return setRecording(null);
                  }
                  const a = eventToAccelerator(e.nativeEvent);
                  if (a) {
                    setBinding(c.id, a);
                    setRecording(null);
                  }
                }}
                className={cx(inputClass, "w-44 border-accent text-xs")}
                data-recording-shortcut
              />
            ) : (
              <button type="button" onClick={() => setRecording(c.id)} className="flex min-w-44 justify-end rounded px-1 py-0.5 hover:bg-hover">
                {acc ? <Kbd accelerator={acc} /> : <span className="text-xs text-faint">Unbound</span>}
              </button>
            )}
            <button
              type="button"
              onClick={() => setBinding(c.id, null)}
              disabled={!(c.id in overrides)}
              className="w-12 text-xs text-muted hover:text-fg disabled:invisible"
            >
              Reset
            </button>
          </div>
        );
      })}
    </>
  );
}

function AdvancedTab() {
  const info = useStore((x) => x.appInfo);
  return (
    <>
      <Row label="Database" description={info?.dbPath ?? ""}>
        <Button onClick={() => void backupDatabase()}>
          <DatabaseBackup size={13} className="mr-1 inline" />
          Back up now
        </Button>
      </Row>
      {info?.dbRecoveredFrom && (
        <div className="mt-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs">
          The previous database could not be opened ({info.dbRecoveryReason}). It was preserved at {info.dbRecoveredFrom}.
        </div>
      )}
      <Row label="Version">
        <span className="text-muted">{info?.version ?? "?"}</span>
      </Row>
    </>
  );
}

function NumberInput({ value, min, max, step = 1, onChange }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  return (
    <input
      type="number"
      className={cx(inputClass, "w-24 text-right")}
      defaultValue={value}
      key={value}
      min={min}
      max={max}
      step={step}
      onBlur={(e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}
