import { create } from "zustand";
import type { AppInfo } from "../lib/ipc";
import { leaf, newId, paneIds, removePane, resizeSplit, cloneLayout, splitPane, swapPanes } from "./layout";
import { ACCENTS, DEFAULT_SETTINGS, type Settings } from "./settings";
import type {
  Pane,
  ShellProfile,
  SplitDirection,
  TerminalRuntime,
  TerminalSurface,
  UiState,
  Workspace,
} from "./types";

export type Overlay =
  | { kind: "palette"; initialQuery?: string }
  | { kind: "settings"; tab?: string }
  | { kind: "workspace"; workspaceId: string }
  | null;

export interface Toast {
  id: string;
  kind: "info" | "error" | "success";
  message: string;
}

// Lifecycle hook so the terminal registry can tear down processes when
// surfaces leave the model, without the store importing the registry.
type RemovedListener = (surfaceIds: string[]) => void;
const removedListeners = new Set<RemovedListener>();
export function onSurfacesRemoved(fn: RemovedListener): () => void {
  removedListeners.add(fn);
  return () => removedListeners.delete(fn);
}
function emitRemoved(ids: string[]) {
  if (ids.length) removedListeners.forEach((fn) => fn(ids));
}

export interface AppStore {
  loaded: boolean;
  appInfo: AppInfo | null;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  ui: UiState;
  settings: Settings;
  profiles: ShellProfile[];
  runtime: Record<string, TerminalRuntime>;
  /** Maximized pane in the active workspace (not persisted). */
  zoomedPaneId: string | null;
  overlay: Overlay;
  searchSurfaceId: string | null;
  renamingWorkspaceId: string | null;
  toasts: Toast[];

  // workspaces
  createWorkspace: (opts?: { name?: string; cwd?: string | null }) => string;
  setActiveWorkspace: (id: string) => void;
  cycleWorkspace: (delta: number) => void;
  activateWorkspaceIndex: (index: number) => void;
  updateWorkspace: (id: string, patch: Partial<Omit<Workspace, "id" | "panes" | "layout">>) => void;
  deleteWorkspace: (id: string) => void;
  duplicateWorkspace: (id: string) => string | null;
  moveWorkspace: (id: string, toIndex: number) => void;
  togglePin: (id: string) => void;

  // panes & surfaces
  focusPane: (paneId: string) => void;
  splitFocused: (direction: SplitDirection, paneId?: string) => void;
  newTerminalTab: (paneId?: string) => void;
  setActiveSurface: (paneId: string, surfaceId: string) => void;
  cycleTab: (delta: number) => void;
  closeSurface: (surfaceId: string) => void;
  closePane: (paneId: string) => void;
  resizeLayout: (workspaceId: string, splitId: string, sizes: number[]) => void;
  swapWithNeighbor: (paneId: string, otherPaneId: string) => void;
  toggleZoom: (paneId?: string) => void;
  renameSurface: (surfaceId: string, title: string, custom: boolean) => void;
  setSurfaceCwd: (surfaceId: string, cwd: string) => void;
  setSurfaceProfile: (surfaceId: string, profileId: string | null) => void;

  // misc
  setRuntime: (surfaceId: string, patch: Partial<TerminalRuntime>) => void;
  setUi: (patch: Partial<UiState>) => void;
  setOverlay: (o: Overlay) => void;
  setSearchSurface: (id: string | null) => void;
  setRenaming: (id: string | null) => void;
  toast: (kind: Toast["kind"], message: string) => void;
  dismissToast: (id: string) => void;
}

// ------------------------------------------------------------------ helpers

export const activeWorkspace = (s: AppStore): Workspace | undefined =>
  s.workspaces.find((w) => w.id === s.activeWorkspaceId);

export function focusedPane(ws: Workspace): Pane | undefined {
  return ws.panes.find((p) => p.id === ws.focusedPaneId) ?? ws.panes[0];
}

export function activeSurface(pane: Pane | undefined): TerminalSurface | undefined {
  if (!pane) return undefined;
  return pane.surfaces.find((s) => s.id === pane.activeSurfaceId) ?? pane.surfaces[0];
}

export function findSurface(
  workspaces: Workspace[],
  surfaceId: string,
): { ws: Workspace; pane: Pane; surface: TerminalSurface } | undefined {
  for (const ws of workspaces) {
    for (const pane of ws.panes) {
      const surface = pane.surfaces.find((s) => s.id === surfaceId);
      if (surface) return { ws, pane, surface };
    }
  }
  return undefined;
}

function makeSurface(ws: Pick<Workspace, "shellProfileId" | "cwd">, settings: Settings, cwd?: string | null): TerminalSurface {
  return {
    id: newId(),
    kind: "terminal",
    title: "Terminal",
    customTitle: false,
    shellProfileId: ws.shellProfileId ?? settings.defaultShellProfileId ?? null,
    cwd: cwd ?? ws.cwd ?? null,
    lastRun: null,
  };
}

function makePane(surface?: TerminalSurface): Pane {
  return { id: newId(), surfaces: surface ? [surface] : [], activeSurfaceId: surface?.id ?? null };
}

/** cwd of the focused terminal, used so splits/new tabs open "here". */
function currentCwd(s: AppStore, ws: Workspace, paneId?: string): string | null {
  const pane = paneId ? ws.panes.find((p) => p.id === paneId) : focusedPane(ws);
  const surf = activeSurface(pane);
  if (!surf) return ws.cwd;
  return s.runtime[surf.id]?.cwd ?? surf.cwd ?? ws.cwd;
}

const pinnedCount = (list: Workspace[]) => list.filter((w) => w.pinned).length;

function nextWorkspaceName(list: Workspace[]): string {
  const used = new Set(list.map((w) => w.name));
  for (let i = 1; ; i++) {
    const name = `Workspace ${i}`;
    if (!used.has(name)) return name;
  }
}

// -------------------------------------------------------------------- store

export const useStore = create<AppStore>((set, get) => {
  /** Apply `fn` to one workspace immutably. */
  const updateWs = (id: string, fn: (ws: Workspace) => Workspace) =>
    set((s) => ({ workspaces: s.workspaces.map((w) => (w.id === id ? fn(w) : w)) }));

  const withActive = (fn: (ws: Workspace, s: AppStore) => void) => {
    const s = get();
    const ws = activeWorkspace(s);
    if (ws) fn(ws, s);
  };

  /** Remove a pane from a workspace, keeping at least one (possibly empty) pane. */
  const dropPane = (ws: Workspace, paneId: string): Workspace => {
    const layout = removePane(ws.layout, paneId);
    if (!layout) {
      const empty = makePane();
      return { ...ws, panes: [empty], layout: leaf(empty.id), focusedPaneId: empty.id };
    }
    const panes = ws.panes.filter((p) => p.id !== paneId);
    const remaining = paneIds(layout);
    const focusedPaneId =
      ws.focusedPaneId && ws.focusedPaneId !== paneId && remaining.includes(ws.focusedPaneId)
        ? ws.focusedPaneId
        : (remaining[0] ?? null);
    return { ...ws, panes, layout, focusedPaneId };
  };

  return {
    loaded: false,
    appInfo: null,
    workspaces: [],
    activeWorkspaceId: null,
    ui: { sidebarWidth: 248, sidebarCollapsed: false },
    settings: DEFAULT_SETTINGS,
    profiles: [],
    runtime: {},
    zoomedPaneId: null,
    overlay: null,
    searchSurfaceId: null,
    renamingWorkspaceId: null,
    toasts: [],

    createWorkspace: (opts) => {
      const s = get();
      const base = { shellProfileId: null, cwd: opts?.cwd ?? null };
      const surface = makeSurface(base, s.settings);
      const pane = makePane(surface);
      const ws: Workspace = {
        id: newId(),
        name: opts?.name?.trim() || nextWorkspaceName(s.workspaces),
        color: ACCENTS[s.workspaces.length % ACCENTS.length]!,
        icon: null,
        cwd: opts?.cwd ?? null,
        pinned: false,
        layout: leaf(pane.id),
        focusedPaneId: pane.id,
        shellProfileId: null,
        startupCommands: [],
        env: {},
        panes: [pane],
        createdAt: Date.now(),
      };
      set({ workspaces: [...s.workspaces, ws], activeWorkspaceId: ws.id, zoomedPaneId: null });
      return ws.id;
    },

    setActiveWorkspace: (id) => {
      if (get().workspaces.some((w) => w.id === id)) {
        set({ activeWorkspaceId: id, zoomedPaneId: null, searchSurfaceId: null });
      }
    },

    cycleWorkspace: (delta) => {
      const { workspaces, activeWorkspaceId } = get();
      if (workspaces.length < 2) return;
      const idx = workspaces.findIndex((w) => w.id === activeWorkspaceId);
      const next = workspaces[(idx + delta + workspaces.length) % workspaces.length]!;
      get().setActiveWorkspace(next.id);
    },

    activateWorkspaceIndex: (index) => {
      const ws = get().workspaces[index];
      if (ws) get().setActiveWorkspace(ws.id);
    },

    updateWorkspace: (id, patch) => updateWs(id, (w) => ({ ...w, ...patch })),

    deleteWorkspace: (id) => {
      const s = get();
      const idx = s.workspaces.findIndex((w) => w.id === id);
      const ws = s.workspaces[idx];
      if (!ws) return;
      const remaining = s.workspaces.filter((w) => w.id !== id);
      let active = s.activeWorkspaceId;
      if (active === id) active = (remaining[idx] ?? remaining[idx - 1] ?? null)?.id ?? null;
      set({ workspaces: remaining, activeWorkspaceId: active, zoomedPaneId: null });
      emitRemoved(ws.panes.flatMap((p) => p.surfaces.map((x) => x.id)));
      if (remaining.length === 0) get().createWorkspace();
    },

    duplicateWorkspace: (id) => {
      const s = get();
      const src = s.workspaces.find((w) => w.id === id);
      if (!src) return null;
      const paneMap = new Map<string, string>();
      const panes: Pane[] = src.panes.map((p) => {
        const np = makePane();
        paneMap.set(p.id, np.id);
        np.surfaces = p.surfaces.map((sf) => ({
          ...sf,
          id: newId(),
          cwd: s.runtime[sf.id]?.cwd ?? sf.cwd,
          lastRun: null,
        }));
        const activeIdx = p.surfaces.findIndex((x) => x.id === p.activeSurfaceId);
        np.activeSurfaceId = np.surfaces[Math.max(0, activeIdx)]?.id ?? null;
        return np;
      });
      const copy: Workspace = {
        ...src,
        id: newId(),
        name: `${src.name} copy`,
        pinned: false,
        panes,
        layout: cloneLayout(src.layout, paneMap),
        focusedPaneId: src.focusedPaneId ? (paneMap.get(src.focusedPaneId) ?? null) : null,
        env: { ...src.env },
        startupCommands: [...src.startupCommands],
        createdAt: Date.now(),
      };
      const idx = s.workspaces.findIndex((w) => w.id === id);
      const list = [...s.workspaces];
      list.splice(Math.max(idx + 1, pinnedCount(list)), 0, copy);
      set({ workspaces: list, activeWorkspaceId: copy.id, zoomedPaneId: null });
      return copy.id;
    },

    moveWorkspace: (id, toIndex) => {
      const list = [...get().workspaces];
      const from = list.findIndex((w) => w.id === id);
      const ws = list[from];
      if (!ws) return;
      list.splice(from, 1);
      // Keep pinned workspaces grouped at the top.
      const pc = pinnedCount(list);
      const lo = ws.pinned ? 0 : pc;
      const hi = ws.pinned ? pc : list.length;
      list.splice(Math.min(hi, Math.max(lo, toIndex)), 0, ws);
      set({ workspaces: list });
    },

    togglePin: (id) => {
      const list = [...get().workspaces];
      const idx = list.findIndex((w) => w.id === id);
      const ws = list[idx];
      if (!ws) return;
      list.splice(idx, 1);
      const updated = { ...ws, pinned: !ws.pinned };
      list.splice(pinnedCount(list), 0, updated);
      set({ workspaces: list });
    },

    focusPane: (paneId) =>
      withActive((ws) => {
        if (ws.focusedPaneId !== paneId && ws.panes.some((p) => p.id === paneId)) {
          updateWs(ws.id, (w) => ({ ...w, focusedPaneId: paneId }));
        }
      }),

    splitFocused: (direction, paneId) =>
      withActive((ws, s) => {
        const target = paneId ?? focusedPane(ws)?.id;
        if (!target) return;
        const surface = makeSurface(ws, s.settings, currentCwd(s, ws, target));
        const pane = makePane(surface);
        updateWs(ws.id, (w) => ({
          ...w,
          panes: [...w.panes, pane],
          layout: splitPane(w.layout, target, pane.id, direction),
          focusedPaneId: pane.id,
        }));
        set({ zoomedPaneId: null });
      }),

    newTerminalTab: (paneId) =>
      withActive((ws, s) => {
        const pane = paneId ? ws.panes.find((p) => p.id === paneId) : focusedPane(ws);
        if (!pane) return;
        const surface = makeSurface(ws, s.settings, currentCwd(s, ws, pane.id));
        updateWs(ws.id, (w) => ({
          ...w,
          focusedPaneId: pane.id,
          panes: w.panes.map((p) =>
            p.id === pane.id ? { ...p, surfaces: [...p.surfaces, surface], activeSurfaceId: surface.id } : p,
          ),
        }));
      }),

    setActiveSurface: (paneId, surfaceId) =>
      withActive((ws) =>
        updateWs(ws.id, (w) => ({
          ...w,
          focusedPaneId: paneId,
          panes: w.panes.map((p) => (p.id === paneId ? { ...p, activeSurfaceId: surfaceId } : p)),
        })),
      ),

    cycleTab: (delta) =>
      withActive((ws) => {
        const pane = focusedPane(ws);
        if (!pane || pane.surfaces.length < 2) return;
        const idx = pane.surfaces.findIndex((x) => x.id === pane.activeSurfaceId);
        const next = pane.surfaces[(idx + delta + pane.surfaces.length) % pane.surfaces.length]!;
        get().setActiveSurface(pane.id, next.id);
      }),

    closeSurface: (surfaceId) => {
      const found = findSurface(get().workspaces, surfaceId);
      if (!found) return;
      const { ws, pane } = found;
      const surfaces = pane.surfaces.filter((x) => x.id !== surfaceId);
      if (surfaces.length === 0 && ws.panes.length > 1) {
        updateWs(ws.id, (w) => dropPane(w, pane.id));
      } else {
        const idx = pane.surfaces.findIndex((x) => x.id === surfaceId);
        const activeSurfaceId =
          pane.activeSurfaceId === surfaceId
            ? (surfaces[Math.min(idx, surfaces.length - 1)]?.id ?? null)
            : pane.activeSurfaceId;
        updateWs(ws.id, (w) => ({
          ...w,
          panes: w.panes.map((p) => (p.id === pane.id ? { ...p, surfaces, activeSurfaceId } : p)),
        }));
      }
      if (get().zoomedPaneId === pane.id && surfaces.length === 0) set({ zoomedPaneId: null });
      emitRemoved([surfaceId]);
    },

    closePane: (paneId) =>
      withActive((ws) => {
        const pane = ws.panes.find((p) => p.id === paneId);
        if (!pane) return;
        updateWs(ws.id, (w) => dropPane(w, paneId));
        if (get().zoomedPaneId === paneId) set({ zoomedPaneId: null });
        emitRemoved(pane.surfaces.map((x) => x.id));
      }),

    resizeLayout: (workspaceId, splitId, sizes) =>
      updateWs(workspaceId, (w) => ({ ...w, layout: resizeSplit(w.layout, splitId, sizes) })),

    swapWithNeighbor: (paneId, otherPaneId) =>
      withActive((ws) => updateWs(ws.id, (w) => ({ ...w, layout: swapPanes(w.layout, paneId, otherPaneId) }))),

    toggleZoom: (paneId) =>
      withActive((ws, s) => {
        const target = paneId ?? focusedPane(ws)?.id ?? null;
        set({ zoomedPaneId: s.zoomedPaneId ? null : target });
      }),

    renameSurface: (surfaceId, title, custom) => {
      const found = findSurface(get().workspaces, surfaceId);
      if (!found) return;
      if (!custom && found.surface.customTitle) return; // shell titles never override user titles
      const clean = title.slice(0, 120);
      if (found.surface.title === clean && found.surface.customTitle === custom) return;
      updateWs(found.ws.id, (w) => ({
        ...w,
        panes: w.panes.map((p) => ({
          ...p,
          surfaces: p.surfaces.map((x) => (x.id === surfaceId ? { ...x, title: clean, customTitle: custom } : x)),
        })),
      }));
    },

    setSurfaceCwd: (surfaceId, cwd) => {
      const found = findSurface(get().workspaces, surfaceId);
      if (found && found.surface.cwd !== cwd) {
        updateWs(found.ws.id, (w) => ({
          ...w,
          panes: w.panes.map((p) => ({
            ...p,
            surfaces: p.surfaces.map((x) => (x.id === surfaceId ? { ...x, cwd } : x)),
          })),
        }));
      }
      get().setRuntime(surfaceId, { cwd });
    },

    setSurfaceProfile: (surfaceId, profileId) => {
      const found = findSurface(get().workspaces, surfaceId);
      if (!found) return;
      updateWs(found.ws.id, (w) => ({
        ...w,
        panes: w.panes.map((p) => ({
          ...p,
          surfaces: p.surfaces.map((x) => (x.id === surfaceId ? { ...x, shellProfileId: profileId } : x)),
        })),
      }));
    },

    setRuntime: (surfaceId, patch) =>
      set((s) => ({
        runtime: {
          ...s.runtime,
          [surfaceId]: { ...(s.runtime[surfaceId] ?? { status: "idle" }), ...patch },
        },
      })),

    setUi: (patch) => set((s) => ({ ui: { ...s.ui, ...patch } })),
    setOverlay: (overlay) => set({ overlay }),
    setSearchSurface: (searchSurfaceId) => set({ searchSurfaceId }),
    setRenaming: (renamingWorkspaceId) => set({ renamingWorkspaceId }),

    toast: (kind, message) => {
      const id = newId();
      set((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, message }] }));
      window.setTimeout(() => get().dismissToast(id), kind === "error" ? 9000 : 4000);
    },
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  };
});
