import { describe, expect, it } from "vitest";
import {
  cloneLayout,
  leaf,
  normalize,
  paneIds,
  removePane,
  resizeSplit,
  sanitizeLayout,
  splitPane,
  swapPanes,
} from "./layout";
import type { LayoutNode } from "./types";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function assertInvariants(node: LayoutNode): void {
  if (node.type === "leaf") return;
  expect(node.children.length).toBeGreaterThanOrEqual(2);
  expect(node.sizes.length).toBe(node.children.length);
  expect(sum(node.sizes)).toBeCloseTo(100, 5);
  for (const c of node.children) {
    if (c.type === "split") expect(c.direction).not.toBe(node.direction);
    assertInvariants(c);
  }
  const ids = paneIds(node);
  expect(new Set(ids).size).toBe(ids.length);
}

describe("splitPane", () => {
  it("turns a leaf into a 50/50 split", () => {
    const t = splitPane(leaf("a"), "a", "b", "horizontal");
    expect(t.type).toBe("split");
    expect(paneIds(t)).toEqual(["a", "b"]);
    assertInvariants(t);
  });

  it("adds a sibling when splitting in the parent's direction", () => {
    let t = splitPane(leaf("a"), "a", "b", "horizontal");
    t = splitPane(t, "b", "c", "horizontal");
    expect(t.type === "split" && t.children.length).toBe(3);
    expect(t.type === "split" && t.sizes).toEqual([50, 25, 25]);
    assertInvariants(t);
  });

  it("nests when splitting in the other direction (spec example layout)", () => {
    // PANE1 | (PANE2A / PANE2B) | PANE3
    let t = splitPane(leaf("claude"), "claude", "codex", "horizontal");
    t = splitPane(t, "codex", "browser", "horizontal");
    t = splitPane(t, "codex", "pwsh", "vertical");
    expect(paneIds(t)).toEqual(["claude", "codex", "pwsh", "browser"]);
    assertInvariants(t);
    if (t.type !== "split") throw new Error();
    const mid = t.children[1]!;
    expect(mid.type === "split" && mid.direction).toBe("vertical");
  });

  it("can insert before the target", () => {
    const t = splitPane(leaf("a"), "a", "b", "vertical", true);
    expect(paneIds(t)).toEqual(["b", "a"]);
  });

  it("throws for unknown panes", () => {
    expect(() => splitPane(leaf("a"), "zzz", "b", "horizontal")).toThrow();
  });
});

describe("removePane", () => {
  it("returns null when the last pane is removed", () => {
    expect(removePane(leaf("a"), "a")).toBeNull();
  });

  it("collapses a split with one remaining child", () => {
    const t = splitPane(leaf("a"), "a", "b", "horizontal");
    const r = removePane(t, "b");
    expect(r).toMatchObject({ type: "leaf", paneId: "a" });
  });

  it("flattens same-direction nesting after removal and renormalizes sizes", () => {
    // a | (b / c) ; remove c -> a | b
    let t = splitPane(leaf("a"), "a", "b", "horizontal");
    t = splitPane(t, "b", "c", "vertical");
    // a | (b / (c | d)) ; remove b -> a | c | d (flattened horizontal)
    t = splitPane(t, "c", "d", "horizontal");
    const r = removePane(t, "b")!;
    assertInvariants(r);
    expect(r.type === "split" && r.direction).toBe("horizontal");
    expect(paneIds(r)).toEqual(["a", "c", "d"]);
  });

  it("survives many random operations without breaking invariants", () => {
    let t: LayoutNode = leaf("p0");
    let n = 1;
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 400; i++) {
      const ids = paneIds(t);
      const target = ids[Math.floor(rand() * ids.length)]!;
      if (rand() < 0.6 || ids.length < 2) {
        t = splitPane(t, target, `p${n++}`, rand() < 0.5 ? "horizontal" : "vertical", rand() < 0.3);
      } else {
        t = removePane(t, target)!;
      }
      assertInvariants(t);
    }
  });
});

describe("other operations", () => {
  it("swaps panes", () => {
    let t = splitPane(leaf("a"), "a", "b", "horizontal");
    t = swapPanes(t, "a", "b");
    expect(paneIds(t)).toEqual(["b", "a"]);
  });

  it("resizes a split and normalizes sizes", () => {
    const t = splitPane(leaf("a"), "a", "b", "horizontal");
    const r = resizeSplit(t, t.id, [30, 90]);
    expect(r.type === "split" && r.sizes).toEqual([25, 75]);
  });

  it("clones with remapped pane ids and fresh node ids", () => {
    const t = splitPane(leaf("a"), "a", "b", "vertical");
    const c = cloneLayout(t, new Map([["a", "x"], ["b", "y"]]));
    expect(paneIds(c)).toEqual(["x", "y"]);
    expect(c.id).not.toBe(t.id);
  });

  it("normalize fixes bad sizes", () => {
    const bad: LayoutNode = {
      type: "split",
      id: "s",
      direction: "horizontal",
      children: [leaf("a"), leaf("b")],
      sizes: [NaN, 5],
    };
    expect(normalize(bad)).toMatchObject({ sizes: [50, 50] });
  });
});

describe("sanitizeLayout", () => {
  it("drops unknown and duplicate panes and appends missing ones", () => {
    const raw = {
      type: "split",
      id: "s",
      direction: "horizontal",
      sizes: [50, 30, 20],
      children: [
        { type: "leaf", id: "1", paneId: "a" },
        { type: "leaf", id: "2", paneId: "ghost" },
        { type: "leaf", id: "3", paneId: "a" },
      ],
    };
    const t = sanitizeLayout(raw, ["a", "b"])!;
    expect(paneIds(t)).toEqual(["a", "b"]);
    assertInvariants(t);
  });

  it("handles garbage input", () => {
    expect(sanitizeLayout("nope", [])).toBeNull();
    expect(paneIds(sanitizeLayout(null, ["a"])!)).toEqual(["a"]);
  });
});
