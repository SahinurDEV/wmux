// Pure operations that move terminal tabs between panes and workspaces.
// Moving never closes a terminal: the surface keeps its id, so the registry
// keeps its xterm instance and its running process.
import { newId, paneIds, removePane, splitPane } from "./layout";
import type { Pane, SplitDirection, TerminalSurface, Workspace } from "./types";

export type Edge = "left" | "right" | "top" | "bottom";

export type MoveTarget =
  /** Into a pane's tab strip, at `index` (default: the end). */
  | { kind: "pane"; paneId: string; index?: number }
  /** Into a new pane created on one side of an existing pane. */
  | { kind: "edge"; paneId: string; edge: Edge }
  /** Into another workspace, as a new pane beside its focused pane. */
  | { kind: "workspace"; workspaceId: string };

export interface MoveResult {
  workspaces: Workspace[];
  /** Workspace and pane that now hold the surface. */
  workspaceId: string;
  paneId: string;
}

const edgeSplit: Record<Edge, { direction: SplitDirection; before: boolean }> = {
  left: { direction: "horizontal", before: true },
  right: { direction: "horizontal", before: false },
  top: { direction: "vertical", before: true },
  bottom: { direction: "vertical", before: false },
};

function locate(workspaces: Workspace[], surfaceId: string) {
  for (const ws of workspaces) {
    for (const pane of ws.panes) {
      const surface = pane.surfaces.find((s) => s.id === surfaceId);
      if (surface) return { ws, pane, surface };
    }
  }
  return undefined;
}

/** Take a surface out of its pane; an emptied pane is removed unless it is the workspace's last. */
function detach(ws: Workspace, pane: Pane, surfaceId: string): Workspace {
  const idx = pane.surfaces.findIndex((s) => s.id === surfaceId);
  const surfaces = pane.surfaces.filter((s) => s.id !== surfaceId);
  if (surfaces.length === 0 && ws.panes.length > 1) {
    const layout = removePane(ws.layout, pane.id)!;
    const remaining = paneIds(layout);
    return {
      ...ws,
      layout,
      panes: ws.panes.filter((p) => p.id !== pane.id),
      focusedPaneId: ws.focusedPaneId !== pane.id && ws.focusedPaneId ? ws.focusedPaneId : (remaining[0] ?? null),
    };
  }
  const activeSurfaceId =
    pane.activeSurfaceId === surfaceId
      ? (surfaces[Math.min(idx, surfaces.length - 1)]?.id ?? null)
      : pane.activeSurfaceId;
  return { ...ws, panes: ws.panes.map((p) => (p.id === pane.id ? { ...p, surfaces, activeSurfaceId } : p)) };
}

function addPane(ws: Workspace, surface: TerminalSurface, besidePaneId: string, edge: Edge): { ws: Workspace; paneId: string } {
  const pane: Pane = { id: newId(), surfaces: [surface], activeSurfaceId: surface.id };
  const { direction, before } = edgeSplit[edge];
  return {
    ws: {
      ...ws,
      panes: [...ws.panes, pane],
      layout: splitPane(ws.layout, besidePaneId, pane.id, direction, before),
      focusedPaneId: pane.id,
    },
    paneId: pane.id,
  };
}

function addTab(ws: Workspace, surface: TerminalSurface, paneId: string, index?: number): Workspace {
  return {
    ...ws,
    focusedPaneId: paneId,
    panes: ws.panes.map((p) => {
      if (p.id !== paneId) return p;
      const surfaces = [...p.surfaces];
      surfaces.splice(Math.min(Math.max(index ?? surfaces.length, 0), surfaces.length), 0, surface);
      return { ...p, surfaces, activeSurfaceId: surface.id };
    }),
  };
}

/**
 * Move one terminal tab. Returns null when the move would change nothing or
 * its target does not exist.
 */
export function moveSurface(workspaces: Workspace[], surfaceId: string, target: MoveTarget): MoveResult | null {
  const src = locate(workspaces, surfaceId);
  if (!src) return null;
  const { surface } = src;
  const onlyTab = src.pane.surfaces.length === 1;

  const targetWs =
    target.kind === "workspace"
      ? workspaces.find((w) => w.id === target.workspaceId)
      : workspaces.find((w) => w.panes.some((p) => p.id === target.paneId));
  if (!targetWs) return null;

  if (target.kind === "workspace" && targetWs.id === src.ws.id) return null;
  // Splitting a pane with its own only tab would recreate the same pane.
  if (target.kind === "edge" && target.paneId === src.pane.id && onlyTab) return null;
  if (target.kind === "pane" && target.paneId === src.pane.id) {
    const from = src.pane.surfaces.findIndex((s) => s.id === surfaceId);
    const to = Math.min(target.index ?? src.pane.surfaces.length, src.pane.surfaces.length);
    // Dropping a tab onto either side of itself keeps the order.
    if (to === from || to === from + 1) return null;
  }

  // Detach first; look everything up again afterwards since panes may have gone.
  let list = workspaces.map((w) => (w.id === src.ws.id ? detach(w, src.pane, surfaceId) : w));
  const dest = list.find((w) => w.id === targetWs.id)!;
  let paneId: string;
  let updated: Workspace;

  if (target.kind === "pane") {
    let index = target.index;
    if (target.paneId === src.pane.id && index !== undefined) {
      const from = src.pane.surfaces.findIndex((s) => s.id === surfaceId);
      if (from < index) index -= 1; // the tab's own slot is gone
    }
    updated = addTab(dest, surface, target.paneId, index);
    paneId = target.paneId;
  } else if (target.kind === "edge") {
    ({ ws: updated, paneId } = addPane(dest, surface, target.paneId, target.edge));
  } else {
    const empty = dest.panes.length === 1 && dest.panes[0]!.surfaces.length === 0 ? dest.panes[0]! : undefined;
    if (empty) {
      updated = addTab(dest, surface, empty.id);
      paneId = empty.id;
    } else {
      const beside = dest.focusedPaneId && dest.panes.some((p) => p.id === dest.focusedPaneId)
        ? dest.focusedPaneId
        : paneIds(dest.layout).at(-1)!;
      ({ ws: updated, paneId } = addPane(dest, surface, beside, "right"));
    }
  }
  list = list.map((w) => (w.id === updated.id ? updated : w));
  return { workspaces: list, workspaceId: updated.id, paneId };
}

/** Move a whole pane, with all its tabs in order, into another workspace. */
export function movePaneToWorkspace(workspaces: Workspace[], paneId: string, workspaceId: string): MoveResult | null {
  const srcWs = workspaces.find((w) => w.panes.some((p) => p.id === paneId));
  const pane = srcWs?.panes.find((p) => p.id === paneId);
  if (!srcWs || !pane || pane.surfaces.length === 0 || srcWs.id === workspaceId) return null;
  const active = pane.activeSurfaceId;
  const [first, ...rest] = pane.surfaces;
  let result = moveSurface(workspaces, first!.id, { kind: "workspace", workspaceId });
  if (!result) return null;
  for (const s of rest) {
    const next = moveSurface(result.workspaces, s.id, { kind: "pane", paneId: result.paneId });
    if (next) result = next;
  }
  // Keep the tab that was in front in front.
  const dest = result.paneId;
  return {
    ...result,
    workspaces: result.workspaces.map((w) =>
      w.id === result!.workspaceId
        ? { ...w, panes: w.panes.map((p) => (p.id === dest && active ? { ...p, activeSurfaceId: active } : p)) }
        : w,
    ),
  };
}

/** Which part of a pane a point is over: an edge strip, or the middle. */
export function dropZone(x: number, y: number, width: number, height: number): Edge | "center" {
  if (width <= 0 || height <= 0) return "center";
  const fx = x / width;
  const fy = y / height;
  const margin = 0.28;
  const nearest = Math.min(fx, 1 - fx, fy, 1 - fy);
  if (nearest > margin) return "center";
  if (nearest === fx) return "left";
  if (nearest === 1 - fx) return "right";
  return nearest === fy ? "top" : "bottom";
}
