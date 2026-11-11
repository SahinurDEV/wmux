import { Fragment, useCallback } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useStore } from "../state/store";
import type { LayoutNode, Workspace } from "../state/types";
import { PaneView } from "./PaneView";

export function WorkspaceView({ ws }: { ws: Workspace }) {
  const zoomed = useStore((s) => s.zoomedPaneId);
  const zoomedPane = zoomed ? ws.panes.find((p) => p.id === zoomed) : undefined;
  return (
    <div className="relative h-full w-full bg-surface">
      {zoomedPane ? (
        <PaneView key={zoomedPane.id} ws={ws} pane={zoomedPane} multi zoomed />
      ) : (
        <LayoutRenderer ws={ws} node={ws.layout} multi={ws.panes.length > 1} />
      )}
    </div>
  );
}

function LayoutRenderer({ ws, node, multi }: { ws: Workspace; node: LayoutNode; multi: boolean }) {
  const resizeLayout = useStore((s) => s.resizeLayout);
  const onLayout = useCallback(
    (sizes: number[]) => {
      if (node.type !== "split") return;
      const same =
        sizes.length === node.sizes.length && sizes.every((v, i) => Math.abs(v - (node.sizes[i] ?? 0)) < 0.05);
      if (!same) resizeLayout(ws.id, node.id, sizes);
    },
    [node, resizeLayout, ws.id],
  );

  if (node.type === "leaf") {
    const pane = ws.panes.find((p) => p.id === node.paneId);
    return pane ? <PaneView ws={ws} pane={pane} multi={multi} /> : null;
  }

  // Remount the group when its structure changes so new default sizes apply;
  // terminals survive because they live in the registry, not in React.
  const structureKey = `${node.id}:${node.children.map((c) => c.id).join(",")}`;
  return (
    <PanelGroup key={structureKey} direction={node.direction} onLayout={onLayout}>
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          {i > 0 && <PanelResizeHandle className="wm-resize-handle" />}
          <Panel id={child.id} order={i} defaultSize={node.sizes[i]} minSize={6}>
            <LayoutRenderer ws={ws} node={child} multi={multi} />
          </Panel>
        </Fragment>
      ))}
    </PanelGroup>
  );
}
