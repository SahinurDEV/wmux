import { beforeEach, describe, expect, it } from "vitest";
import { paneIds } from "./layout";
import { fromSnapshot, toSnapshot } from "./persistence";
import { activeWorkspace, onSurfacesRemoved, useStore } from "./store";

const initial = useStore.getState();
const st = () => useStore.getState();
const ws = () => activeWorkspace(st())!;

beforeEach(() => {
  useStore.setState({ ...initial, workspaces: [], activeWorkspaceId: null, runtime: {} }, true);
});

describe("workspace management", () => {
  it("creates and switches workspaces with independent state", () => {
    const a = st().createWorkspace({ name: "frontend" });
    const b = st().createWorkspace();
    expect(st().activeWorkspaceId).toBe(b);
    expect(ws().name).toBe("Workspace 1");
    st().splitFocused("horizontal");
    expect(ws().panes).toHaveLength(2);
    st().setActiveWorkspace(a);
    expect(ws().name).toBe("frontend");
    expect(ws().panes).toHaveLength(1);
  });

  it("deleting a workspace emits removed surfaces and always keeps one workspace", () => {
    const removed: string[] = [];
    const off = onSurfacesRemoved((ids) => removed.push(...ids));
    const id = st().createWorkspace();
    const surfaceId = ws().panes[0]!.surfaces[0]!.id;
    st().deleteWorkspace(id);
    off();
    expect(removed).toEqual([surfaceId]);
    expect(st().workspaces).toHaveLength(1);
    expect(st().workspaces[0]!.id).not.toBe(id);
  });

  it("duplicates with fresh ids and the same structure", () => {
    const id = st().createWorkspace({ name: "api" });
    st().splitFocused("vertical");
    st().newTerminalTab();
    const copyId = st().duplicateWorkspace(id)!;
    const src = st().workspaces.find((w) => w.id === id)!;
    const copy = st().workspaces.find((w) => w.id === copyId)!;
    expect(copy.name).toBe("api copy");
    expect(copy.panes.map((p) => p.surfaces.length)).toEqual(src.panes.map((p) => p.surfaces.length));
    const srcIds = new Set(src.panes.flatMap((p) => [p.id, ...p.surfaces.map((s) => s.id)]));
    for (const p of copy.panes) {
      expect(srcIds.has(p.id)).toBe(false);
      for (const s of p.surfaces) expect(srcIds.has(s.id)).toBe(false);
    }
    expect(paneIds(copy.layout).sort()).toEqual(copy.panes.map((p) => p.id).sort());
  });

  it("keeps pinned workspaces first and reorders within groups", () => {
    const a = st().createWorkspace({ name: "a" });
    const b = st().createWorkspace({ name: "b" });
    const c = st().createWorkspace({ name: "c" });
    st().togglePin(c);
    expect(st().workspaces.map((w) => w.id)).toEqual([c, a, b]);
    // Unpinned can't move above pinned.
    st().moveWorkspace(b, 0);
    expect(st().workspaces.map((w) => w.id)).toEqual([c, b, a]);
  });

  it("cycles and activates by index", () => {
    const a = st().createWorkspace();
    const b = st().createWorkspace();
    st().cycleWorkspace(1);
    expect(st().activeWorkspaceId).toBe(a);
    st().activateWorkspaceIndex(1);
    expect(st().activeWorkspaceId).toBe(b);
  });
});

describe("panes and tabs", () => {
  it("splits, tabs and closes, collapsing empty panes", () => {
    st().createWorkspace();
    const first = ws().panes[0]!.id;
    st().splitFocused("horizontal");
    const second = ws().focusedPaneId!;
    expect(second).not.toBe(first);
    st().newTerminalTab();
    expect(ws().panes.find((p) => p.id === second)!.surfaces).toHaveLength(2);

    for (const s of [...ws().panes.find((p) => p.id === second)!.surfaces]) st().closeSurface(s.id);
    expect(ws().panes.map((p) => p.id)).toEqual([first]);
    expect(ws().layout).toMatchObject({ type: "leaf", paneId: first });
  });

  it("closing the last terminal leaves an empty pane", () => {
    st().createWorkspace();
    st().closeSurface(ws().panes[0]!.surfaces[0]!.id);
    expect(ws().panes).toHaveLength(1);
    expect(ws().panes[0]!.surfaces).toHaveLength(0);
  });

  it("new splits inherit the focused terminal's live cwd", () => {
    st().createWorkspace({ cwd: "C:\\start" });
    const s1 = ws().panes[0]!.surfaces[0]!.id;
    st().setSurfaceCwd(s1, "C:\\moved");
    st().splitFocused("vertical");
    const newPane = ws().panes.find((p) => p.id === ws().focusedPaneId)!;
    expect(newPane.surfaces[0]!.cwd).toBe("C:\\moved");
  });

  it("shell titles never override user-set titles", () => {
    st().createWorkspace();
    const s1 = ws().panes[0]!.surfaces[0]!.id;
    st().renameSurface(s1, "my server", true);
    st().renameSurface(s1, "pwsh.exe", false);
    expect(ws().panes[0]!.surfaces[0]!.title).toBe("my server");
  });
});

describe("snapshot roundtrip", () => {
  it("restores the same model", () => {
    st().createWorkspace({ name: "one", cwd: "C:\\x" });
    st().splitFocused("horizontal");
    st().splitFocused("vertical");
    st().createWorkspace({ name: "two" });
    st().togglePin(st().activeWorkspaceId!);
    const snap = JSON.parse(JSON.stringify(toSnapshot(st())));
    const restored = fromSnapshot(snap);
    expect(restored.activeWorkspaceId).toBe(st().activeWorkspaceId);
    expect(restored.workspaces.map((w) => w.name)).toEqual(st().workspaces.map((w) => w.name));
    expect(restored.workspaces.map((w) => w.layout)).toEqual(st().workspaces.map((w) => w.layout));
  });

  it("repairs corrupted layouts instead of losing panes", () => {
    st().createWorkspace();
    st().splitFocused("horizontal");
    const snap = JSON.parse(JSON.stringify(toSnapshot(st())));
    snap.workspaces[0].layout = { type: "garbage" };
    snap.workspaces[0].focusedPaneId = "nope";
    const restored = fromSnapshot(snap).workspaces[0]!;
    expect(paneIds(restored.layout).sort()).toEqual(restored.panes.map((p) => p.id).sort());
    expect(restored.panes.map((p) => p.id)).toContain(restored.focusedPaneId);
  });
});
