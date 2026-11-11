import { useEffect, useRef, useState } from "react";
import {
  Copy,
  FolderOpen,
  MoreHorizontal,
  Palette,
  Pencil,
  Pin,
  PinOff,
  Plus,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { closeWorkspace, openFolderAsWorkspace } from "../state/actions";
import { ACCENTS } from "../state/settings";
import { useStore } from "../state/store";
import type { Workspace } from "../state/types";
import { IconButton, cx, useMenu, type MenuItem } from "./ui";

const basename = (p: string | null) => (p ? (p.split(/[\\/]/).filter(Boolean).pop() ?? p) : null);

export function Sidebar() {
  const workspaces = useStore((s) => s.workspaces);
  const width = useStore((s) => s.ui.sidebarWidth);
  const setUi = useStore((s) => s.setUi);
  const createWorkspace = useStore((s) => s.createWorkspace);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const moveWorkspace = useStore((s) => s.moveWorkspace);

  const pinned = workspaces.filter((w) => w.pinned);
  const others = workspaces.filter((w) => !w.pinned);

  const onResizeStart = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const move = (ev: PointerEvent) =>
      setUi({ sidebarWidth: Math.min(480, Math.max(180, startW + ev.clientX - startX)) });
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const renderGroup = (list: Workspace[]) =>
    list.map((ws) => {
      const index = workspaces.indexOf(ws);
      return (
        <WorkspaceItem
          key={ws.id}
          ws={ws}
          index={index}
          dragging={dragId === ws.id}
          dropBefore={dropIndex === index && dragId !== ws.id}
          onDragStart={() => setDragId(ws.id)}
          onDragOver={(before) => setDropIndex(before ? index : index + 1)}
          onDrop={() => {
            if (dragId && dropIndex !== null) {
              const from = workspaces.findIndex((w) => w.id === dragId);
              moveWorkspace(dragId, from < dropIndex ? dropIndex - 1 : dropIndex);
            }
            setDragId(null);
            setDropIndex(null);
          }}
          onDragEnd={() => {
            setDragId(null);
            setDropIndex(null);
          }}
        />
      );
    });

  return (
    <aside style={{ width }} className="relative flex shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex h-9 items-center justify-between pr-2 pl-3">
        <span className="text-[11px] font-semibold tracking-wider text-faint uppercase">Workspaces</span>
        <div className="flex gap-0.5">
          <IconButton title="Open folder as workspace (Ctrl+Shift+O)" onClick={() => void openFolderAsWorkspace()}>
            <FolderOpen size={14} />
          </IconButton>
          <IconButton title="New workspace (Ctrl+Shift+N)" onClick={() => createWorkspace()}>
            <Plus size={15} />
          </IconButton>
        </div>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2" aria-label="Workspaces">
        {pinned.length > 0 && (
          <>
            <div className="px-2 pt-1 pb-1 text-[10px] font-semibold tracking-wider text-faint uppercase">Pinned</div>
            {renderGroup(pinned)}
            <div className="mx-2 my-2 h-px bg-line" />
          </>
        )}
        {renderGroup(others)}
        {dropIndex === workspaces.length && <div className="mx-2 h-0.5 rounded bg-accent" />}
      </nav>
      <div
        onPointerDown={onResizeStart}
        className="absolute top-0 right-[-3px] z-10 h-full w-[6px] cursor-col-resize hover:bg-accent/40"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
      />
    </aside>
  );
}

function WorkspaceItem({
  ws,
  index,
  dragging,
  dropBefore,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  ws: Workspace;
  index: number;
  dragging: boolean;
  dropBefore: boolean;
  onDragStart: () => void;
  onDragOver: (before: boolean) => void;
  onDrop: () => void;
  onDragEnd: () => void;
}) {
  const active = useStore((s) => s.activeWorkspaceId === ws.id);
  const renaming = useStore((s) => s.renamingWorkspaceId === ws.id);
  const runtime = useStore((s) => s.runtime);
  const s = useStore.getState;
  const menu = useMenu();

  const surfaces = ws.panes.flatMap((p) => p.surfaces);
  const running = surfaces.filter((x) => runtime[x.id]?.status === "running").length;
  const errored = surfaces.some((x) => runtime[x.id]?.status === "error");
  const liveCwd = surfaces.map((x) => runtime[x.id]?.cwd).find(Boolean) ?? ws.cwd;

  const items: MenuItem[] = [
    { label: "Rename", icon: <Pencil size={13} />, onSelect: () => s().setRenaming(ws.id) },
    { label: "Duplicate", icon: <Copy size={13} />, onSelect: () => s().duplicateWorkspace(ws.id) },
    {
      label: ws.pinned ? "Unpin" : "Pin to top",
      icon: ws.pinned ? <PinOff size={13} /> : <Pin size={13} />,
      onSelect: () => s().togglePin(ws.id),
    },
    {
      label: "Workspace settings…",
      icon: <SlidersHorizontal size={13} />,
      onSelect: () => s().setOverlay({ kind: "workspace", workspaceId: ws.id }),
    },
    { separator: true, label: "" },
    {
      label: "",
      custom: (
        <div className="flex items-center gap-1.5 px-2 py-1.5">
          <Palette size={13} className="mr-1 text-muted" />
          {ACCENTS.map((c) => (
            <button
              key={c}
              type="button"
              title={c}
              aria-label={`Color ${c}`}
              onClick={() => s().updateWorkspace(ws.id, { color: c })}
              className={cx("h-4 w-4 rounded-full", ws.color === c && "ring-2 ring-fg/60 ring-offset-1 ring-offset-elev")}
              style={{ background: c }}
            />
          ))}
        </div>
      ),
    },
    { separator: true, label: "" },
    { label: "Close workspace", icon: <Trash2 size={13} />, danger: true, onSelect: () => void closeWorkspace(ws.id) },
  ];

  return (
    <>
      {dropBefore && <div className="mx-2 h-0.5 rounded bg-accent" />}
      <div
        role="button"
        tabIndex={0}
        aria-current={active}
        draggable={!renaming}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", ws.id);
          onDragStart();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          onDragOver(e.clientY < r.top + r.height / 2);
        }}
        onDrop={(e) => {
          e.preventDefault();
          onDrop();
        }}
        onDragEnd={onDragEnd}
        onClick={() => s().setActiveWorkspace(ws.id)}
        onDoubleClick={() => s().setRenaming(ws.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter") s().setActiveWorkspace(ws.id);
          if (e.key === "F2") s().setRenaming(ws.id);
        }}
        onContextMenu={(e) => menu.open(e, items)}
        className={cx(
          "group relative mb-0.5 flex cursor-pointer items-center gap-2.5 rounded-lg py-1.5 pr-1 pl-2.5 transition-colors",
          active ? "bg-active" : "hover:bg-hover",
          dragging && "opacity-40",
        )}
      >
        <span
          className={cx("absolute top-2 bottom-2 left-0 w-[3px] rounded-r", !active && "opacity-0")}
          style={{ background: ws.color }}
        />
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[11px] font-bold"
          style={{ background: `color-mix(in srgb, ${ws.color} 22%, transparent)`, color: ws.color }}
        >
          {ws.icon || ws.name.trim().charAt(0).toUpperCase() || "W"}
        </span>
        <div className="min-w-0 flex-1">
          {renaming ? (
            <RenameInput ws={ws} />
          ) : (
            <div className={cx("truncate text-[13px]", active ? "font-medium text-fg" : "text-fg/90")}>{ws.name}</div>
          )}
          <div className="flex items-center gap-1.5 truncate text-[11px] text-faint">
            <span className="truncate">{basename(liveCwd) ?? "~"}</span>
            <span>·</span>
            <span className="shrink-0">
              {surfaces.length} term{surfaces.length === 1 ? "" : "s"}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {errored && <span className="h-1.5 w-1.5 rounded-full bg-danger" title="A terminal failed to start" />}
          {running > 0 && !errored && (
            <span className="h-1.5 w-1.5 rounded-full bg-success" title={`${running} running`} />
          )}
          {ws.pinned && <Pin size={11} className="text-faint" />}
          {index < 9 && <span className="text-[10px] text-faint group-hover:hidden">⌃{index + 1}</span>}
          <button
            type="button"
            aria-label="Workspace actions"
            onClick={(e) => menu.open(e, items)}
            className="hidden h-5 w-5 items-center justify-center rounded text-muted group-hover:flex hover:bg-line-strong hover:text-fg"
          >
            <MoreHorizontal size={14} />
          </button>
        </div>
      </div>
      {menu.element}
    </>
  );
}

function RenameInput({ ws }: { ws: Workspace }) {
  const [value, setValue] = useState(ws.name);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const { updateWorkspace, setRenaming } = useStore.getState();
    if (save && value.trim()) updateWorkspace(ws.id, { name: value.trim().slice(0, 80) });
    setRenaming(null);
  };
  return (
    <input
      ref={ref}
      value={value}
      aria-label="Workspace name"
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit(true);
        if (e.key === "Escape") commit(false);
      }}
      onBlur={() => commit(true)}
      className="h-5 w-full rounded border border-accent bg-surface px-1 text-[13px] outline-none"
    />
  );
}
