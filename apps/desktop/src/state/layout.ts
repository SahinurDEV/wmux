// Pure, immutable operations on the recursive split-layout tree.
//
// Invariants maintained by every operation (and restored by `normalize`):
//  * a split node has >= 2 children and `sizes.length === children.length`
//  * sizes are positive and sum to 100
//  * a split never has a child split with the same direction (flattened)
//  * every pane id appears in at most one leaf
import type { LayoutNode, SplitDirection } from "./types";

export const newId = (): string => crypto.randomUUID();

export function leaf(paneId: string, id: string = newId()): LayoutNode {
  return { type: "leaf", id, paneId };
}

export function paneIds(node: LayoutNode): string[] {
  return node.type === "leaf" ? [node.paneId] : node.children.flatMap(paneIds);
}

export function containsPane(node: LayoutNode, paneId: string): boolean {
  return node.type === "leaf"
    ? node.paneId === paneId
    : node.children.some((c) => containsPane(c, paneId));
}

function equalSizes(n: number): number[] {
  return Array.from({ length: n }, () => 100 / n);
}

function normalizeSizes(sizes: number[], n: number): number[] {
  if (sizes.length !== n || sizes.some((s) => !Number.isFinite(s) || s <= 0)) {
    return equalSizes(n);
  }
  const total = sizes.reduce((a, b) => a + b, 0);
  return sizes.map((s) => (s / total) * 100);
}

/** Restore invariants: collapse single-child splits, flatten same-direction nesting, fix sizes. */
export function normalize(node: LayoutNode): LayoutNode | null {
  if (node.type === "leaf") return node;
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  const base = normalizeSizes(node.sizes, node.children.length);
  node.children.forEach((child, i) => {
    const c = normalize(child);
    if (!c) return;
    const share = base[i] ?? 0;
    if (c.type === "split" && c.direction === node.direction) {
      c.children.forEach((gc, j) => {
        children.push(gc);
        sizes.push((share * (c.sizes[j] ?? 0)) / 100);
      });
    } else {
      children.push(c);
      sizes.push(share);
    }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return { ...node, children, sizes: normalizeSizes(sizes, children.length) };
}

/**
 * Split the leaf containing `targetPaneId`, placing `newPaneId` after it
 * (right for horizontal, below for vertical) or before it when `before`.
 * If the parent already splits in the same direction the new pane becomes a
 * sibling that takes half of the target's share.
 */
export function splitPane(
  root: LayoutNode,
  targetPaneId: string,
  newPaneId: string,
  direction: SplitDirection,
  before = false,
): LayoutNode {
  if (!containsPane(root, targetPaneId)) {
    throw new Error(`pane ${targetPaneId} is not in this layout`);
  }
  const rec = (node: LayoutNode): LayoutNode => {
    if (node.type === "leaf") {
      if (node.paneId !== targetPaneId) return node;
      const created = leaf(newPaneId);
      return {
        type: "split",
        id: newId(),
        direction,
        children: before ? [created, node] : [node, created],
        sizes: [50, 50],
      };
    }
    if (node.direction === direction) {
      const idx = node.children.findIndex(
        (c) => c.type === "leaf" && c.paneId === targetPaneId,
      );
      if (idx >= 0) {
        const children = [...node.children];
        const sizes = [...node.sizes];
        const half = (sizes[idx] ?? 0) / 2;
        sizes[idx] = half;
        const insertAt = before ? idx : idx + 1;
        children.splice(insertAt, 0, leaf(newPaneId));
        sizes.splice(insertAt, 0, half);
        return { ...node, children, sizes };
      }
    }
    return { ...node, children: node.children.map(rec) };
  };
  return normalize(rec(root))!;
}

/** Remove a pane's leaf. Returns null when the layout becomes empty. */
export function removePane(root: LayoutNode, paneId: string): LayoutNode | null {
  const rec = (node: LayoutNode): LayoutNode | null => {
    if (node.type === "leaf") return node.paneId === paneId ? null : node;
    const children: LayoutNode[] = [];
    const sizes: number[] = [];
    node.children.forEach((c, i) => {
      const r = rec(c);
      if (r) {
        children.push(r);
        sizes.push(node.sizes[i] ?? 0);
      }
    });
    return { ...node, children, sizes };
  };
  const result = rec(root);
  return result ? normalize(result) : null;
}

/** Swap the positions of two panes. */
export function swapPanes(root: LayoutNode, a: string, b: string): LayoutNode {
  if (a === b) return root;
  const rec = (node: LayoutNode): LayoutNode => {
    if (node.type === "leaf") {
      if (node.paneId === a) return { ...node, paneId: b };
      if (node.paneId === b) return { ...node, paneId: a };
      return node;
    }
    return { ...node, children: node.children.map(rec) };
  };
  return rec(root);
}

/** Update the sizes of the split node with `splitId`. */
export function resizeSplit(root: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
  const rec = (node: LayoutNode): LayoutNode => {
    if (node.type === "leaf") return node;
    if (node.id === splitId) {
      return { ...node, sizes: normalizeSizes(sizes, node.children.length) };
    }
    return { ...node, children: node.children.map(rec) };
  };
  return rec(root);
}

/** Deep-copy a layout with fresh node ids and pane ids remapped by `map`. */
export function cloneLayout(node: LayoutNode, map: Map<string, string>): LayoutNode {
  if (node.type === "leaf") {
    return leaf(map.get(node.paneId) ?? node.paneId);
  }
  return {
    ...node,
    id: newId(),
    children: node.children.map((c) => cloneLayout(c, map)),
    sizes: [...node.sizes],
  };
}

/**
 * Validate an untrusted (persisted) layout against the set of known panes.
 * Leaves referencing unknown panes are dropped, duplicates removed, and panes
 * missing from the tree are appended so nothing is silently lost.
 */
export function sanitizeLayout(raw: unknown, knownPaneIds: string[]): LayoutNode | null {
  const known = new Set(knownPaneIds);
  const seen = new Set<string>();
  const rec = (n: unknown, depth: number): LayoutNode | null => {
    if (!n || typeof n !== "object" || depth > 32) return null;
    const o = n as Record<string, unknown>;
    const id = typeof o.id === "string" && o.id ? o.id : newId();
    if (o.type === "leaf" && typeof o.paneId === "string") {
      if (!known.has(o.paneId) || seen.has(o.paneId)) return null;
      seen.add(o.paneId);
      return { type: "leaf", id, paneId: o.paneId };
    }
    if (o.type === "split" && Array.isArray(o.children)) {
      const direction: SplitDirection = o.direction === "vertical" ? "vertical" : "horizontal";
      const rawSizes = Array.isArray(o.sizes) ? o.sizes.map(Number) : [];
      const children: LayoutNode[] = [];
      const sizes: number[] = [];
      o.children.forEach((c, i) => {
        const r = rec(c, depth + 1);
        if (r) {
          children.push(r);
          sizes.push(rawSizes[i] ?? NaN);
        }
      });
      return { type: "split", id, direction, children, sizes };
    }
    return null;
  };
  let tree = rec(raw, 0);
  tree = tree ? normalize(tree) : null;
  const missing = knownPaneIds.filter((p) => !seen.has(p));
  for (const p of missing) {
    tree = tree ? splitPane(tree, paneIds(tree).at(-1)!, p, "horizontal") : leaf(p);
  }
  return tree;
}
