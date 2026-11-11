// Cross-cutting actions that touch IPC, dialogs or the terminal registry.
import { ask, open as openDialog } from "@tauri-apps/plugin-dialog";
import { errorMessage, ipc } from "../lib/ipc";
import * as terminals from "../terminal/registry";
import { settingsToStore, type Settings } from "./settings";
import { activeSurface, activeWorkspace, focusedPane, useStore } from "./store";

const st = () => useStore.getState();

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  const prev = st().settings;
  useStore.setState({ settings: { ...prev, ...patch } });
  try {
    await ipc.settingsSet(settingsToStore(patch));
    if ("customProfiles" in patch) await refreshProfiles();
  } catch (e) {
    useStore.setState({ settings: prev });
    st().toast("error", `Could not save settings: ${errorMessage(e)}`);
  }
}

export async function refreshProfiles(): Promise<void> {
  try {
    useStore.setState({ profiles: await ipc.listShellProfiles() });
  } catch (e) {
    st().toast("error", `Could not detect shells: ${errorMessage(e)}`);
  }
}

export function focusedSurfaceId(): string | undefined {
  const ws = activeWorkspace(st());
  if (!ws) return undefined;
  const pane = ws.panes.find((p) => p.id === (st().zoomedPaneId ?? ws.focusedPaneId)) ?? focusedPane(ws);
  return activeSurface(pane)?.id;
}

export async function closeWorkspace(id?: string): Promise<void> {
  const s = st();
  const ws = id ? s.workspaces.find((w) => w.id === id) : activeWorkspace(s);
  if (!ws) return;
  const terminalsInWs = ws.panes.reduce((n, p) => n + p.surfaces.length, 0);
  if (s.settings.confirmCloseWorkspace && terminalsInWs > 0) {
    const ok = await ask(
      `Close "${ws.name}"? ${terminalsInWs} terminal${terminalsInWs === 1 ? "" : "s"} and their processes will be stopped.`,
      { title: "Close workspace", kind: "warning", okLabel: "Close workspace", cancelLabel: "Cancel" },
    );
    if (!ok) return;
  }
  st().deleteWorkspace(ws.id);
}

export async function openFolderAsWorkspace(): Promise<void> {
  try {
    const dir = await openDialog({ directory: true, multiple: false, title: "Open folder as workspace" });
    if (typeof dir !== "string") return;
    const name = dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
    st().createWorkspace({ name, cwd: dir });
  } catch (e) {
    st().toast("error", `Could not open folder: ${errorMessage(e)}`);
  }
}

export async function pickDirectory(defaultPath?: string | null): Promise<string | null> {
  const dir = await openDialog({ directory: true, multiple: false, defaultPath: defaultPath ?? undefined });
  return typeof dir === "string" ? dir : null;
}

export function withFocusedTerminal(fn: (surfaceId: string) => void) {
  const id = focusedSurfaceId();
  if (id) fn(id);
}

export function focusDirection(dir: "left" | "right" | "up" | "down") {
  const ws = activeWorkspace(st());
  if (!ws || st().zoomedPaneId) return;
  const current = document.querySelector<HTMLElement>(`[data-pane-id="${ws.focusedPaneId}"]`);
  if (!current) return;
  const a = current.getBoundingClientRect();
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  let best: { id: string; score: number } | null = null;
  for (const el of document.querySelectorAll<HTMLElement>("[data-pane-id]")) {
    const id = el.dataset.paneId!;
    if (id === ws.focusedPaneId) continue;
    const b = el.getBoundingClientRect();
    const bx = b.left + b.width / 2;
    const by = b.top + b.height / 2;
    const ok =
      (dir === "left" && b.right <= a.left + 2) ||
      (dir === "right" && b.left >= a.right - 2) ||
      (dir === "up" && b.bottom <= a.top + 2) ||
      (dir === "down" && b.top >= a.bottom - 2);
    if (!ok) continue;
    const primary = dir === "left" || dir === "right" ? Math.abs(bx - ax) : Math.abs(by - ay);
    const secondary = dir === "left" || dir === "right" ? Math.abs(by - ay) : Math.abs(bx - ax);
    const score = primary + secondary * 2;
    if (!best || score < best.score) best = { id, score };
  }
  if (best) {
    st().focusPane(best.id);
    const surf = activeSurface(ws.panes.find((p) => p.id === best!.id));
    if (surf) terminals.focus(surf.id);
  }
}

export async function backupDatabase(): Promise<void> {
  try {
    const path = await ipc.dbBackup();
    st().toast("success", `Database backed up to ${path}`);
  } catch (e) {
    st().toast("error", `Backup failed: ${errorMessage(e)}`);
  }
}
