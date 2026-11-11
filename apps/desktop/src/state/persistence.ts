// Mapping between the in-memory store and the SQLite snapshot, plus a
// debounced autosave. Loaded data is treated as untrusted and sanitized.
import { errorMessage, ipc, type SessionSnapshot, type WorkspaceRecord } from "../lib/ipc";
import { leaf, newId, sanitizeLayout } from "./layout";
import { ACCENTS } from "./settings";
import { useStore, type AppStore } from "./store";
import type { Pane, TerminalSurface, UiState, Workspace } from "./types";

const SAVE_DEBOUNCE_MS = 400;

export function toSnapshot(s: Pick<AppStore, "workspaces" | "activeWorkspaceId" | "ui" | "runtime">): SessionSnapshot {
  return {
    activeWorkspaceId: s.activeWorkspaceId,
    ui: s.ui,
    workspaces: s.workspaces.map(
      (w): WorkspaceRecord => ({
        id: w.id,
        name: w.name,
        color: w.color,
        icon: w.icon,
        cwd: w.cwd,
        pinned: w.pinned,
        layout: w.layout,
        focusedPaneId: w.focusedPaneId,
        shellProfileId: w.shellProfileId,
        startupCommands: w.startupCommands,
        env: w.env,
        createdAt: w.createdAt,
        panes: w.panes.map((p) => ({
          id: p.id,
          activeSurfaceId: p.activeSurfaceId,
          surfaces: p.surfaces.map((sf) => ({
            id: sf.id,
            kind: sf.kind,
            title: sf.title,
            customTitle: sf.customTitle,
            shellProfileId: sf.shellProfileId,
            cwd: s.runtime[sf.id]?.cwd ?? sf.cwd,
          })),
        })),
      }),
    ),
  };
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function fromSnapshot(snap: SessionSnapshot): {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  ui: Partial<UiState>;
} {
  const workspaces: Workspace[] = [];
  for (const [i, r] of (snap.workspaces ?? []).entries()) {
    const panes: Pane[] = (r.panes ?? []).map((p) => {
      const surfaces: TerminalSurface[] = (p.surfaces ?? [])
        .filter((sf) => sf.kind === "terminal")
        .map((sf) => ({
          id: sf.id,
          kind: "terminal",
          title: str(sf.title) ?? "Terminal",
          customTitle: !!sf.customTitle,
          shellProfileId: str(sf.shellProfileId),
          cwd: str(sf.cwd),
          lastRun: sf.lastRun ?? null,
        }));
      const active = surfaces.some((x) => x.id === p.activeSurfaceId) ? p.activeSurfaceId : (surfaces[0]?.id ?? null);
      return { id: p.id, surfaces, activeSurfaceId: active };
    });
    if (panes.length === 0) panes.push({ id: newId(), surfaces: [], activeSurfaceId: null });
    const ids = panes.map((p) => p.id);
    const layout = sanitizeLayout(r.layout, ids) ?? leaf(ids[0]!);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.env ?? {})) if (typeof v === "string") env[k] = v;
    workspaces.push({
      id: r.id,
      name: str(r.name) || `Workspace ${i + 1}`,
      color: /^#[0-9a-f]{6}$/i.test(r.color ?? "") ? r.color : ACCENTS[i % ACCENTS.length]!,
      icon: str(r.icon),
      cwd: str(r.cwd),
      pinned: !!r.pinned,
      layout,
      focusedPaneId: r.focusedPaneId && ids.includes(r.focusedPaneId) ? r.focusedPaneId : ids[0]!,
      shellProfileId: str(r.shellProfileId),
      startupCommands: Array.isArray(r.startupCommands) ? r.startupCommands.filter((c) => typeof c === "string") : [],
      env,
      panes,
      createdAt: typeof r.createdAt === "number" ? r.createdAt : Date.now(),
    });
  }
  // Keep pinned workspaces grouped first.
  workspaces.sort((a, b) => Number(b.pinned) - Number(a.pinned));
  const activeWorkspaceId = workspaces.some((w) => w.id === snap.activeWorkspaceId)
    ? snap.activeWorkspaceId
    : (workspaces[0]?.id ?? null);
  const rawUi = (snap.ui && typeof snap.ui === "object" ? snap.ui : {}) as Record<string, unknown>;
  const ui: Partial<UiState> = {};
  if (typeof rawUi.sidebarWidth === "number") ui.sidebarWidth = Math.min(480, Math.max(180, rawUi.sidebarWidth));
  if (typeof rawUi.sidebarCollapsed === "boolean") ui.sidebarCollapsed = rawUi.sidebarCollapsed;
  return { workspaces, activeWorkspaceId, ui };
}

let timer: number | undefined;
let saving: Promise<void> = Promise.resolve();
let lastSaved = "";
let reportedError = false;

async function saveNow(): Promise<void> {
  const snap = toSnapshot(useStore.getState());
  const json = JSON.stringify(snap);
  if (json === lastSaved) return;
  try {
    await ipc.sessionSave(snap);
    lastSaved = json;
    reportedError = false;
  } catch (e) {
    // Report once per failure streak instead of spamming toasts.
    if (!reportedError) useStore.getState().toast("error", `Could not save session: ${errorMessage(e)}`);
    reportedError = true;
  }
}

/** Save immediately (e.g. before the window closes). */
export function flushSave(): Promise<void> {
  window.clearTimeout(timer);
  saving = saving.then(saveNow);
  return saving;
}

/** Load the saved session into the store and start autosaving changes. */
export async function initPersistence(): Promise<void> {
  const snap = await ipc.sessionLoad();
  const { workspaces, activeWorkspaceId, ui } = fromSnapshot(snap);
  useStore.setState((s) => ({ workspaces, activeWorkspaceId, ui: { ...s.ui, ...ui } }));
  if (workspaces.length === 0) {
    useStore.getState().createWorkspace({ cwd: useStore.getState().appInfo?.homeDir ?? null });
  }
  lastSaved = JSON.stringify(toSnapshot(useStore.getState()));

  useStore.subscribe((s, prev) => {
    if (s.workspaces === prev.workspaces && s.activeWorkspaceId === prev.activeWorkspaceId && s.ui === prev.ui) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      saving = saving.then(saveNow);
    }, SAVE_DEBOUNCE_MS);
  });
}
