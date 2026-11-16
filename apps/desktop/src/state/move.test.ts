import { describe, expect, it } from "vitest";
import { leaf, paneIds, splitPane } from "./layout";
import { dropZone, movePaneToWorkspace, moveSurface } from "./move";
import type { LayoutNode, Pane, TerminalSurface, Workspace } from "./types";

const surface = (id: string): TerminalSurface => ({
  id,
  kind: "terminal",
  title: id,
  customTitle: false,
  shellProfileId: null,
  cwd: null,
});

const pane = (id: string, ...surfaces: string[]): Pane => ({
  id,
  surfaces: surfaces.map(surface),
  activeSurfaceId: surfaces[0] ?? null,
});

function workspace(id: string, panes: Pane[]): Workspace {
  let layout: LayoutNode = leaf(panes[0]!.id);
  for (const p of panes.slice(1)) layout = splitPane(layout, paneIds(layout).at(-1)!, p.id, "horizontal");
  return {
    id,
    name: id,
    color: "#7c8cff",
    icon: null,
    cwd: null,
    pinned: false,
    layout,
    focusedPaneId: panes[0]!.id,
    shellProfileId: null,
    startupCommands: [],
    env: {},
    panes,
    createdAt: 0,
  };
}

const tabs = (ws: Workspace, paneId: string) => ws.panes.find((p) => p.id === paneId)?.surfaces.map((s) => s.id);
const allSurfaces = (list: Workspace[]) => list.flatMap((w) => w.panes.flatMap((p) => p.surfaces.map((s) => s.id))).sort();

/** Every pane is in the layout exactly once and nothing else is. */
function expectConsistent(list: Workspace[]) {
  for (const ws of list) {
    expect([...paneIds(ws.layout)].sort()).toEqual(ws.panes.map((p) => p.id).sort());
    for (const p of ws.panes) {
      if (p.surfaces.length) expect(p.surfaces.some((s) => s.id === p.activeSurfaceId)).toBe(true);
      else expect(p.activeSurfaceId).toBeNull();
    }
    expect(ws.panes.some((p) => p.id === ws.focusedPaneId)).toBe(true);
  }
}

describe("moveSurface", () => {
  it("moves a tab into another pane and focuses it there", () => {
    const list = [workspace("w", [pane("p1", "a", "b"), pane("p2", "c")])];
    const r = moveSurface(list, "a", { kind: "pane", paneId: "p2" })!;
    const ws = r.workspaces[0]!;
    expect(tabs(ws, "p1")).toEqual(["b"]);
    expect(tabs(ws, "p2")).toEqual(["c", "a"]);
    expect(ws.panes.find((p) => p.id === "p2")!.activeSurfaceId).toBe("a");
    expect(ws.panes.find((p) => p.id === "p1")!.activeSurfaceId).toBe("b");
    expect(ws.focusedPaneId).toBe("p2");
    expectConsistent(r.workspaces);
  });

  it("removes the source pane when its last tab leaves", () => {
    const list = [workspace("w", [pane("p1", "a"), pane("p2", "c")])];
    const r = moveSurface(list, "a", { kind: "pane", paneId: "p2", index: 0 })!;
    const ws = r.workspaces[0]!;
    expect(ws.panes.map((p) => p.id)).toEqual(["p2"]);
    expect(tabs(ws, "p2")).toEqual(["a", "c"]);
    expectConsistent(r.workspaces);
  });

  it("reorders tabs within a pane and treats drops next to itself as no-ops", () => {
    const list = [workspace("w", [pane("p1", "a", "b", "c")])];
    expect(tabs(moveSurface(list, "a", { kind: "pane", paneId: "p1", index: 3 })!.workspaces[0]!, "p1")).toEqual(["b", "c", "a"]);
    expect(tabs(moveSurface(list, "a", { kind: "pane", paneId: "p1", index: 2 })!.workspaces[0]!, "p1")).toEqual(["b", "a", "c"]);
    expect(tabs(moveSurface(list, "c", { kind: "pane", paneId: "p1", index: 0 })!.workspaces[0]!, "p1")).toEqual(["c", "a", "b"]);
    expect(moveSurface(list, "b", { kind: "pane", paneId: "p1", index: 1 })).toBeNull();
    expect(moveSurface(list, "b", { kind: "pane", paneId: "p1", index: 2 })).toBeNull();
    expect(moveSurface(list, "c", { kind: "pane", paneId: "p1" })).toBeNull();
  });

  it("tears a tab off into a new pane on the chosen side", () => {
    const list = [workspace("w", [pane("p1", "a", "b")])];
    const r = moveSurface(list, "b", { kind: "edge", paneId: "p1", edge: "left" })!;
    const ws = r.workspaces[0]!;
    expect(ws.panes).toHaveLength(2);
    expect(ws.layout.type).toBe("split");
    if (ws.layout.type !== "split") throw new Error("expected a split");
    expect(ws.layout.direction).toBe("horizontal");
    expect(paneIds(ws.layout)).toEqual([r.paneId, "p1"]);
    expect(tabs(ws, r.paneId)).toEqual(["b"]);
    expect(ws.focusedPaneId).toBe(r.paneId);
    expectConsistent(r.workspaces);

    const below = moveSurface(list, "b", { kind: "edge", paneId: "p1", edge: "bottom" })!.workspaces[0]!;
    if (below.layout.type !== "split") throw new Error("expected a split");
    expect(below.layout.direction).toBe("vertical");
    expect(paneIds(below.layout)[0]).toBe("p1");
  });

  it("moves a single-tab pane beside another pane", () => {
    const list = [workspace("w", [pane("p1", "a"), pane("p2", "b"), pane("p3", "c")])];
    const r = moveSurface(list, "a", { kind: "edge", paneId: "p3", edge: "right" })!;
    const ws = r.workspaces[0]!;
    expect(paneIds(ws.layout)).toEqual(["p2", "p3", r.paneId]);
    expect(ws.panes.some((p) => p.id === "p1")).toBe(false);
    expectConsistent(r.workspaces);
  });

  it("refuses to split a pane with its own only tab", () => {
    const list = [workspace("w", [pane("p1", "a")])];
    expect(moveSurface(list, "a", { kind: "edge", paneId: "p1", edge: "right" })).toBeNull();
  });

  it("moves a tab to another workspace without losing it", () => {
    const list = [workspace("w1", [pane("p1", "a", "b")]), workspace("w2", [pane("p2", "c")])];
    const r = moveSurface(list, "a", { kind: "workspace", workspaceId: "w2" })!;
    expect(r.workspaceId).toBe("w2");
    expect(tabs(r.workspaces[0]!, "p1")).toEqual(["b"]);
    expect(tabs(r.workspaces[1]!, r.paneId)).toEqual(["a"]);
    expect(r.workspaces[1]!.panes).toHaveLength(2);
    expect(allSurfaces(r.workspaces)).toEqual(["a", "b", "c"]);
    expectConsistent(r.workspaces);
  });

  it("leaves an empty pane behind when a workspace's only tab moves away, and reuses one on arrival", () => {
    const list = [workspace("w1", [pane("p1", "a")]), workspace("w2", [pane("p2", "c")])];
    const r = moveSurface(list, "a", { kind: "workspace", workspaceId: "w2" })!;
    expect(r.workspaces[0]!.panes).toHaveLength(1);
    expect(tabs(r.workspaces[0]!, "p1")).toEqual([]);
    expectConsistent(r.workspaces);

    const back = moveSurface(r.workspaces, "c", { kind: "workspace", workspaceId: "w1" })!;
    expect(back.paneId).toBe("p1");
    expect(tabs(back.workspaces[0]!, "p1")).toEqual(["c"]);
    expectConsistent(back.workspaces);
  });

  it("returns null for unknown surfaces, panes and workspaces", () => {
    const list = [workspace("w", [pane("p1", "a")])];
    expect(moveSurface(list, "zzz", { kind: "pane", paneId: "p1" })).toBeNull();
    expect(moveSurface(list, "a", { kind: "pane", paneId: "nope" })).toBeNull();
    expect(moveSurface(list, "a", { kind: "workspace", workspaceId: "nope" })).toBeNull();
    expect(moveSurface(list, "a", { kind: "workspace", workspaceId: "w" })).toBeNull();
  });

  it("keeps every terminal and a valid layout through random moves", () => {
    let list = [
      workspace("w1", [pane("p1", "a", "b"), pane("p2", "c")]),
      workspace("w2", [pane("p3", "d"), pane("p4", "e", "f")]),
    ];
    const ids = ["a", "b", "c", "d", "e", "f"];
    const edges = ["left", "right", "top", "bottom"] as const;
    let seed = 7;
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    for (let i = 0; i < 400; i++) {
      const panes = list.flatMap((w) => w.panes.map((p) => p.id));
      const id = ids[rnd(ids.length)]!;
      const kind = rnd(3);
      const r =
        kind === 0
          ? moveSurface(list, id, { kind: "pane", paneId: panes[rnd(panes.length)]!, index: rnd(4) })
          : kind === 1
            ? moveSurface(list, id, { kind: "edge", paneId: panes[rnd(panes.length)]!, edge: edges[rnd(4)]! })
            : moveSurface(list, id, { kind: "workspace", workspaceId: rnd(2) ? "w1" : "w2" });
      if (!r) continue;
      list = r.workspaces;
      expect(allSurfaces(list)).toEqual(ids);
      expectConsistent(list);
    }
  });
});

describe("movePaneToWorkspace", () => {
  it("moves all tabs in order and keeps the front tab in front", () => {
    const p = pane("p1", "a", "b", "c");
    p.activeSurfaceId = "b";
    const list = [workspace("w1", [p, pane("px", "x")]), workspace("w2", [pane("p2", "d")])];
    const r = movePaneToWorkspace(list, "p1", "w2")!;
    expect(r.workspaces[0]!.panes.map((x) => x.id)).toEqual(["px"]);
    expect(tabs(r.workspaces[1]!, r.paneId)).toEqual(["a", "b", "c"]);
    expect(r.workspaces[1]!.panes.find((x) => x.id === r.paneId)!.activeSurfaceId).toBe("b");
    expectConsistent(r.workspaces);
  });

  it("does nothing for an empty pane or the same workspace", () => {
    const list = [workspace("w1", [pane("p1")]), workspace("w2", [pane("p2", "d")])];
    expect(movePaneToWorkspace(list, "p1", "w2")).toBeNull();
    expect(movePaneToWorkspace(list, "p2", "w2")).toBeNull();
  });
});

describe("dropZone", () => {
  it("maps the middle to a tab drop and the borders to splits", () => {
    expect(dropZone(500, 300, 1000, 600)).toBe("center");
    expect(dropZone(40, 300, 1000, 600)).toBe("left");
    expect(dropZone(960, 300, 1000, 600)).toBe("right");
    expect(dropZone(500, 30, 1000, 600)).toBe("top");
    expect(dropZone(500, 570, 1000, 600)).toBe("bottom");
    expect(dropZone(5, 5, 0, 0)).toBe("center");
  });
});
