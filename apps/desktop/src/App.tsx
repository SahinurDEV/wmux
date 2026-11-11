import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CommandPalette } from "./components/CommandPalette";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TitleBar } from "./components/TitleBar";
import { Toasts } from "./components/Toasts";
import { WorkspaceSettingsDialog } from "./components/WorkspaceSettingsDialog";
import { WorkspaceView } from "./components/WorkspaceView";
import { errorMessage, ipc } from "./lib/ipc";
import { focusedSurfaceId } from "./state/actions";
import { commandById, effectiveBindings, eventToAccelerator, getCommands } from "./state/commands";
import { flushSave, initPersistence } from "./state/persistence";
import { settingsFromStore } from "./state/settings";
import { activeWorkspace, useStore } from "./state/store";
import * as terminals from "./terminal/registry";

let booting: Promise<void> | null = null;
/** Idempotent: React StrictMode runs effects twice in development. */
function boot(): Promise<void> {
  booting ??= doBoot();
  return booting;
}

async function doBoot(): Promise<void> {
  const [appInfo, rawSettings, profiles] = await Promise.all([
    ipc.appInfo(),
    ipc.settingsGet(),
    ipc.listShellProfiles(),
  ]);
  useStore.setState({ appInfo, settings: settingsFromStore(rawSettings), profiles });
  if (profiles.length === 0) {
    useStore.getState().toast("error", "No shells were found on this system (looked for pwsh, powershell, cmd, WSL, Git Bash).");
  }
  if (appInfo.dbRecoveredFrom) {
    useStore
      .getState()
      .toast("error", `Your session database could not be read and was moved to ${appInfo.dbRecoveredFrom}. Starting fresh.`);
  }
  await initPersistence();
  if (appInfo.e2e) {
    Object.assign(window, {
      __wmuxTest: {
        getState: useStore.getState,
        bufferText: terminals.bufferText,
        focusedSurfaceId,
        runCommand: (id: string) => getCommands().find((c) => c.id === id)?.run(),
      },
    });
  }
  useStore.setState({ loaded: true });
}

function useSystemDark(): boolean {
  const query = useMemo(() => window.matchMedia("(prefers-color-scheme: dark)"), []);
  const [dark, setDark] = useState(query.matches);
  useEffect(() => {
    const on = (e: MediaQueryListEvent) => setDark(e.matches);
    query.addEventListener("change", on);
    return () => query.removeEventListener("change", on);
  }, [query]);
  return dark;
}

/** Keys the embedded browser engine would otherwise act on (reload, print, find…). */
const BROWSER_DEFAULTS = new Set(["F5", "Ctrl+R", "Ctrl+Shift+R", "Ctrl+P", "Ctrl+F", "Ctrl+G", "Ctrl+U", "Ctrl+J", "Ctrl+S", "F3", "F7"]);

function useGlobalShortcuts() {
  const overrides = useStore((s) => s.settings.keybindings);
  useEffect(() => {
    const byAccelerator = new Map<string, string>();
    for (const [id, acc] of effectiveBindings(overrides)) byAccelerator.set(acc, id);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.("[data-recording-shortcut]")) return;
      const acc = eventToAccelerator(e);
      if (!acc) return;
      const id = byAccelerator.get(acc);
      if (id) {
        const cmd = commandById(id);
        if (cmd) {
          e.preventDefault();
          e.stopPropagation();
          Promise.resolve(cmd.run()).catch((err) =>
            useStore.getState().toast("error", `${cmd.title} failed: ${errorMessage(err)}`),
          );
          return;
        }
      }
      // Outside terminals, stop WebView2 browser behaviors. Inside a terminal
      // these keys go to the shell (xterm cancels the default itself).
      if (BROWSER_DEFAULTS.has(acc) && !target?.closest?.(".xterm")) e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [overrides]);
}

export function App() {
  const loaded = useStore((s) => s.loaded);
  const settings = useStore((s) => s.settings);
  const ws = useStore(activeWorkspace);
  const collapsed = useStore((s) => s.ui.sidebarCollapsed);
  const overlay = useStore((s) => s.overlay);
  const systemDark = useSystemDark();
  const [bootError, setBootError] = useState<string | null>(null);
  const dark = settings.theme === "system" ? systemDark : settings.theme === "dark";

  useEffect(() => {
    boot()
      .catch((e) => setBootError(errorMessage(e)))
      .finally(() => {
        requestAnimationFrame(() => void getCurrentWindow().show());
      });
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested(async () => {
        await flushSave();
      })
      .then((u) => (unlisten = u));
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = dark ? "dark" : "light";
    root.style.setProperty("--wm-accent", settings.accent);
    terminals.applyAppearance(settings, dark);
  }, [settings, dark]);

  useGlobalShortcuts();

  if (bootError) {
    return (
      <div className="flex h-full flex-col">
        <TitleBar />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <div className="text-lg font-semibold text-danger">Wmux failed to start</div>
          <pre className="max-w-2xl text-xs whitespace-pre-wrap text-muted select-text">{bootError}</pre>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        {!collapsed && <Sidebar />}
        <main className="relative min-w-0 flex-1">{loaded && ws && <WorkspaceView key={ws.id} ws={ws} />}</main>
      </div>
      <StatusBar />
      {overlay?.kind === "palette" && <CommandPalette initialQuery={overlay.initialQuery} />}
      {overlay?.kind === "settings" && <SettingsDialog initialTab={overlay.tab} />}
      {overlay?.kind === "workspace" && <WorkspaceSettingsDialog workspaceId={overlay.workspaceId} />}
      <Toasts />
    </div>
  );
}
