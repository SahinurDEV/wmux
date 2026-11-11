import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Columns2,
  Eraser,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Plus,
  RotateCw,
  Rows2,
  Search,
  Skull,
  SquareTerminal,
  TerminalSquare,
  X,
} from "lucide-react";
import * as terminals from "../terminal/registry";
import { useStore } from "../state/store";
import type { Pane, TerminalSurface, Workspace } from "../state/types";
import { IconButton, cx, useMenu, type MenuItem } from "./ui";

export function PaneView({ ws, pane, multi, zoomed }: { ws: Workspace; pane: Pane; multi: boolean; zoomed?: boolean }) {
  const focused = ws.focusedPaneId === pane.id;
  const isActiveWorkspace = useStore((s) => s.activeWorkspaceId === ws.id);
  const searchSurfaceId = useStore((s) => s.searchSurfaceId);
  const st = useStore.getState;
  const menu = useMenu();
  const active = pane.surfaces.find((x) => x.id === pane.activeSurfaceId) ?? pane.surfaces[0];

  const paneMenu: MenuItem[] = [
    { label: "New terminal tab", icon: <Plus size={13} />, hint: "Ctrl+Shift+T", onSelect: () => st().newTerminalTab(pane.id) },
    { label: "Split right", icon: <Columns2 size={13} />, hint: "Ctrl+Shift+D", onSelect: () => st().splitFocused("horizontal", pane.id) },
    { label: "Split down", icon: <Rows2 size={13} />, hint: "Ctrl+Shift+E", onSelect: () => st().splitFocused("vertical", pane.id) },
    { separator: true, label: "" },
    ...(active
      ? [
          { label: "Search output", icon: <Search size={13} />, hint: "Ctrl+Shift+F", onSelect: () => st().setSearchSurface(active.id) },
          { label: "Clear", icon: <Eraser size={13} />, hint: "Ctrl+Shift+K", onSelect: () => terminals.clear(active.id) },
          { label: "Restart", icon: <RotateCw size={13} />, hint: "Ctrl+Shift+R", onSelect: () => void terminals.restart(active.id) },
          { label: "Kill process tree", icon: <Skull size={13} />, onSelect: () => void terminals.kill(active.id) },
          { separator: true, label: "" },
        ]
      : []),
    { label: "Close pane", icon: <X size={13} />, danger: true, onSelect: () => st().closePane(pane.id) },
  ];

  return (
    <div
      data-pane-id={pane.id}
      onMouseDownCapture={() => st().focusPane(pane.id)}
      className="relative flex h-full w-full flex-col bg-surface"
    >
      <div
        className={cx(
          "@container flex h-8 shrink-0 items-center gap-1 border-b border-line bg-panel/60 pr-1 pl-1",
          multi && focused && "shadow-[inset_0_2px_0_var(--wm-accent)]",
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto" role="tablist">
          {pane.surfaces.map((s) => (
            <Tab key={s.id} surface={s} pane={pane} active={s.id === active?.id} paneFocused={focused} />
          ))}
          <IconButton title="New terminal tab (Ctrl+Shift+T)" onClick={() => st().newTerminalTab(pane.id)}>
            <Plus size={14} />
          </IconButton>
        </div>
        {/* In narrow panes these are only reachable from the "More actions" menu. */}
        <span className="hidden @[22rem]:contents">
          <IconButton title="Split right (Ctrl+Shift+D)" onClick={() => st().splitFocused("horizontal", pane.id)}>
            <Columns2 size={14} />
          </IconButton>
          <IconButton title="Split down (Ctrl+Shift+E)" onClick={() => st().splitFocused("vertical", pane.id)}>
            <Rows2 size={14} />
          </IconButton>
        </span>
        {(multi || zoomed) && (
          <IconButton title={zoomed ? "Restore layout (Ctrl+Shift+Enter)" : "Maximize pane (Ctrl+Shift+Enter)"} onClick={() => st().toggleZoom(pane.id)} active={zoomed}>
            {zoomed ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </IconButton>
        )}
        <IconButton title="More actions" onClick={(e) => menu.open(e, paneMenu)}>
          <MoreHorizontal size={14} />
        </IconButton>
      </div>

      <div className="relative min-h-0 flex-1">
        {active ? (
          <TerminalView
            key={active.id}
            surfaceId={active.id}
            shouldFocus={focused && isActiveWorkspace}
          />
        ) : (
          <EmptyPane onNew={() => st().newTerminalTab(pane.id)} onClose={multi ? () => st().closePane(pane.id) : undefined} />
        )}
        {active && searchSurfaceId === active.id && <SearchBar surfaceId={active.id} />}
      </div>
      {menu.element}
    </div>
  );
}

function Tab({ surface, pane, active, paneFocused }: { surface: TerminalSurface; pane: Pane; active: boolean; paneFocused: boolean }) {
  const rt = useStore((s) => s.runtime[surface.id]);
  const profiles = useStore((s) => s.profiles);
  const [editing, setEditing] = useState(false);
  const st = useStore.getState;
  const menu = useMenu();

  const status = rt?.status ?? "idle";
  const items: MenuItem[] = [
    { label: "Rename tab", onSelect: () => setEditing(true) },
    ...(surface.customTitle
      ? [{ label: "Reset title", onSelect: () => st().renameSurface(surface.id, "Terminal", false) }]
      : []),
    { label: "Restart", icon: <RotateCw size={13} />, onSelect: () => void terminals.restart(surface.id) },
    { separator: true, label: "" },
    ...profiles.map((p) => ({
      label: `Restart as ${p.name}`,
      icon: <SquareTerminal size={13} />,
      hint: (surface.shellProfileId ?? "") === p.id ? "current" : undefined,
      onSelect: () => {
        st().setSurfaceProfile(surface.id, p.id);
        void terminals.restart(surface.id);
      },
    })),
    { separator: true, label: "" },
    { label: "Close tab", icon: <X size={13} />, danger: true, onSelect: () => st().closeSurface(surface.id) },
  ];

  return (
    <div
      role="tab"
      aria-selected={active}
      title={`${surface.title}${rt?.cwd ? `\n${rt.cwd}` : ""}${rt?.pid ? `\nPID ${rt.pid}` : ""}`}
      onClick={() => st().setActiveSurface(pane.id, surface.id)}
      onDoubleClick={() => setEditing(true)}
      onAuxClick={(e) => {
        if (e.button === 1) st().closeSurface(surface.id);
      }}
      onContextMenu={(e) => menu.open(e, items)}
      className={cx(
        "group flex h-6 max-w-52 min-w-14 shrink cursor-pointer items-center gap-1.5 rounded-md pr-1 pl-2 text-xs transition-colors",
        active ? (paneFocused ? "bg-active text-fg" : "bg-hover text-fg") : "text-muted hover:bg-hover hover:text-fg",
      )}
    >
      <TerminalSquare
        size={13}
        className={cx(
          "shrink-0",
          status === "running" && "text-success",
          status === "error" && "text-danger",
          (status === "exited" || status === "idle" || status === "starting") && "text-faint",
        )}
      />
      {editing ? (
        <TabRename surface={surface} onDone={() => setEditing(false)} />
      ) : (
        <span className={cx("truncate", status === "exited" && "line-through decoration-faint")}>{surface.title}</span>
      )}
      <button
        type="button"
        aria-label="Close tab"
        onClick={(e) => {
          e.stopPropagation();
          st().closeSurface(surface.id);
        }}
        className={cx(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-line-strong",
          active ? "opacity-70" : "opacity-0 group-hover:opacity-70",
        )}
      >
        <X size={11} />
      </button>
      {menu.element}
    </div>
  );
}

function TabRename({ surface, onDone }: { surface: TerminalSurface; onDone: () => void }) {
  const [value, setValue] = useState(surface.title);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => {
    if (value.trim()) useStore.getState().renameSurface(surface.id, value.trim(), true);
    onDone();
  };
  return (
    <input
      ref={ref}
      value={value}
      aria-label="Tab title"
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit();
        if (e.key === "Escape") onDone();
      }}
      onBlur={commit}
      className="h-5 w-28 rounded border border-accent bg-surface px-1 text-xs outline-none"
    />
  );
}

function TerminalView({ surfaceId, shouldFocus }: { surfaceId: string; shouldFocus: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    terminals.attach(surfaceId, el);
    return () => terminals.detach(surfaceId, el);
  }, [surfaceId]);

  useEffect(() => {
    if (shouldFocus) {
      const id = requestAnimationFrame(() => terminals.focus(surfaceId));
      return () => cancelAnimationFrame(id);
    }
  }, [shouldFocus, surfaceId]);

  return <div ref={ref} className="absolute inset-0 overflow-hidden" />;
}

function EmptyPane({ onNew, onClose }: { onNew: () => void; onClose?: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-muted">
      <TerminalSquare size={28} className="text-faint" />
      <div className="text-[13px]">No terminals in this pane</div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onNew}
          className="rounded-md border border-line-strong px-3 py-1 text-xs text-fg hover:bg-hover"
        >
          New terminal <span className="text-faint">Ctrl+Shift+T</span>
        </button>
        {onClose && (
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1 text-xs hover:bg-hover">
            Close pane
          </button>
        )}
      </div>
    </div>
  );
}

function SearchBar({ surfaceId }: { surfaceId: string }) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [result, setResult] = useState<{ index: number; count: number } | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const search = terminals.getSearch(surfaceId);

  useEffect(() => {
    ref.current?.focus();
    if (!search) return;
    const d = search.onDidChangeResults((r) => setResult(r ? { index: r.resultIndex, count: r.resultCount } : null));
    return () => {
      d.dispose();
      search.clearDecorations();
    };
  }, [search]);

  const opts = {
    caseSensitive,
    regex,
    incremental: false,
    decorations: {
      matchBackground: "#e0af6855",
      activeMatchBackground: "#e0af68",
      matchOverviewRuler: "#e0af68",
      activeMatchColorOverviewRuler: "#ff9e64",
    },
  };
  const find = (next: boolean, q = query) => {
    if (!search) return;
    if (!q) {
      search.clearDecorations();
      setResult(null);
      return;
    }
    try {
      if (next) search.findNext(q, opts);
      else search.findPrevious(q, opts);
    } catch {
      setResult({ index: -1, count: 0 }); // invalid regex
    }
  };
  const close = () => {
    useStore.getState().setSearchSurface(null);
    terminals.focus(surfaceId);
  };

  return (
    <div
      className="absolute top-2 right-4 z-20 flex items-center gap-1 rounded-lg border border-line-strong bg-elev p-1"
      style={{ boxShadow: "var(--wm-shadow)" }}
    >
      <Search size={13} className="ml-1 text-muted" />
      <input
        ref={ref}
        value={query}
        placeholder="Find in terminal"
        aria-label="Find in terminal"
        onChange={(e) => {
          setQuery(e.target.value);
          find(true, e.target.value);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") find(!e.shiftKey);
          if (e.key === "Escape") close();
        }}
        className="h-6 w-48 bg-transparent px-1 text-xs outline-none"
      />
      <span className="w-14 text-right text-[11px] text-faint">
        {result ? (result.count === 0 ? "No results" : `${result.index + 1}/${result.count}`) : ""}
      </span>
      <IconButton title="Match case" active={caseSensitive} onClick={() => setCaseSensitive((v) => !v)}>
        <span className="text-[11px] font-semibold">Aa</span>
      </IconButton>
      <IconButton title="Regular expression" active={regex} onClick={() => setRegex((v) => !v)}>
        <span className="font-mono text-[11px]">.*</span>
      </IconButton>
      <IconButton title="Previous (Shift+Enter)" onClick={() => find(false)}>
        <ChevronUp size={14} />
      </IconButton>
      <IconButton title="Next (Enter)" onClick={() => find(true)}>
        <ChevronDown size={14} />
      </IconButton>
      <IconButton title="Close (Esc)" onClick={close}>
        <X size={14} />
      </IconButton>
    </div>
  );
}
