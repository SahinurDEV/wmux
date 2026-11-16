// Dragging terminal tabs with the pointer: onto another pane's tab strip, onto
// a side of a pane (new split), or onto a workspace in the sidebar.
//
// Pointer events are used instead of HTML5 drag and drop because the webview
// host intercepts native drags for file drops. Drop targets are plain DOM
// markers (`data-*` attributes), found by hit-testing under the pointer.
import type { PointerEvent as ReactPointerEvent } from "react";
import { dropZone, type MoveTarget } from "../state/move";
import { useStore, type TabDrag } from "../state/store";

const DRAG_THRESHOLD_PX = 6;

type Rect = NonNullable<TabDrag["rect"]>;
const rectOf = (r: DOMRect): Rect => ({ left: r.left, top: r.top, width: r.width, height: r.height });

/** What is under the pointer, ignoring the drag overlay itself. */
function hitTest(x: number, y: number): { target: MoveTarget; rect: Rect } | null {
  const el = document.elementsFromPoint(x, y).find((e) => !e.closest("[data-drag-overlay]"));
  if (!el) return null;

  const wsEl = el.closest<HTMLElement>("[data-workspace-id]");
  if (wsEl) {
    return { target: { kind: "workspace", workspaceId: wsEl.dataset.workspaceId! }, rect: rectOf(wsEl.getBoundingClientRect()) };
  }

  const paneEl = el.closest<HTMLElement>("[data-pane-id]");
  if (!paneEl) return null;
  const paneId = paneEl.dataset.paneId!;

  const strip = el.closest<HTMLElement>("[data-tabstrip]");
  if (strip) {
    const tabs = [...strip.querySelectorAll<HTMLElement>("[data-tab-surface-id]")];
    // Insert before the first tab whose middle is right of the pointer.
    let index = tabs.length;
    let edgeX = tabs.at(-1)?.getBoundingClientRect().right ?? strip.getBoundingClientRect().left;
    for (const [i, tab] of tabs.entries()) {
      const r = tab.getBoundingClientRect();
      if (x < r.left + r.width / 2) {
        index = i;
        edgeX = r.left;
        break;
      }
    }
    const s = strip.getBoundingClientRect();
    return { target: { kind: "pane", paneId, index }, rect: { left: edgeX - 1, top: s.top + 4, width: 2, height: s.height - 8 } };
  }

  const body = paneEl.querySelector<HTMLElement>("[data-pane-body]");
  if (!body) return null;
  const b = body.getBoundingClientRect();
  const zone = dropZone(x - b.left, y - b.top, b.width, b.height);
  if (zone === "center") return { target: { kind: "pane", paneId }, rect: rectOf(b) };
  const half: Record<typeof zone, Rect> = {
    left: { left: b.left, top: b.top, width: b.width / 2, height: b.height },
    right: { left: b.left + b.width / 2, top: b.top, width: b.width / 2, height: b.height },
    top: { left: b.left, top: b.top, width: b.width, height: b.height / 2 },
    bottom: { left: b.left, top: b.top + b.height / 2, width: b.width, height: b.height / 2 },
  };
  return { target: { kind: "edge", paneId, edge: zone }, rect: half[zone] };
}

/**
 * Call from a tab's `onPointerDown`. The drag starts once the pointer has
 * moved a few pixels, so plain clicks still select the tab.
 */
export function beginTabDrag(e: ReactPointerEvent, surfaceId: string, title: string) {
  if (e.button !== 0) return;
  const startX = e.clientX;
  const startY = e.clientY;
  let dragging = false;
  const st = useStore.getState;

  const update = (ev: PointerEvent) => {
    const hit = hitTest(ev.clientX, ev.clientY);
    st().setDrag({ surfaceId, title, x: ev.clientX, y: ev.clientY, target: hit?.target ?? null, rect: hit?.rect ?? null });
  };
  const move = (ev: PointerEvent) => {
    if (!dragging) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD_PX) return;
      dragging = true;
      document.body.style.userSelect = "none";
    }
    update(ev);
  };
  const finish = (commit: boolean) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", key, true);
    document.body.style.userSelect = "";
    const drag = st().drag;
    st().setDrag(null);
    if (!dragging) return;
    // The click that follows this pointerup must not re-select the tab.
    const swallowClick = (ev: MouseEvent) => ev.stopPropagation();
    window.addEventListener("click", swallowClick, true);
    window.setTimeout(() => window.removeEventListener("click", swallowClick, true), 0);
    if (commit && drag?.target) st().moveSurface(surfaceId, drag.target);
  };
  const up = () => finish(true);
  const cancel = () => finish(false);
  const key = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape" || !dragging) return;
    ev.preventDefault();
    ev.stopPropagation();
    finish(false);
  };

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", key, true);
}

/** Full-window layer shown during a drag: the landing area and a label by the pointer. */
export function TabDragOverlay() {
  const drag = useStore((s) => s.drag);
  if (!drag) return null;
  return (
    <div data-drag-overlay className="fixed inset-0 z-50 cursor-grabbing">
      {drag.rect && (
        <div
          className="pointer-events-none absolute rounded-md border border-accent bg-accent/20 transition-[left,top,width,height] duration-75"
          style={drag.rect}
        />
      )}
      <div
        className="pointer-events-none absolute max-w-52 truncate rounded-md border border-line-strong bg-elev px-2 py-1 text-xs text-fg shadow-lg"
        style={{ left: drag.x + 12, top: drag.y + 14 }}
      >
        {drag.title}
      </div>
    </div>
  );
}
