import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, PanelLeft, Search, Settings, Square, X } from "lucide-react";
import { activeWorkspace, useStore } from "../state/store";
import { effectiveBindings } from "../state/commands";
import { IconButton, Kbd, cx } from "./ui";

export function TitleBar() {
  const ws = useStore(activeWorkspace);
  const setOverlay = useStore((s) => s.setOverlay);
  const collapsed = useStore((s) => s.ui.sidebarCollapsed);
  const setUi = useStore((s) => s.setUi);
  const keybindings = useStore((s) => s.settings.keybindings);
  const paletteKey = effectiveBindings(keybindings).get("palette.show");
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    const sync = () => void win.isMaximized().then(setMaximized).catch(() => undefined);
    sync();
    void win.onResized(sync).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, []);

  const win = getCurrentWindow();

  return (
    <header
      data-tauri-drag-region
      className="flex h-9 shrink-0 items-center border-b border-line bg-panel pl-2 select-none"
    >
      <div data-tauri-drag-region className="flex min-w-0 items-center gap-2">
        <IconButton
          title={collapsed ? "Show sidebar" : "Hide sidebar"}
          onClick={() => setUi({ sidebarCollapsed: !collapsed })}
        >
          <PanelLeft size={15} />
        </IconButton>
        <img src="/icon.png" alt="" className="pointer-events-none h-4 w-4" draggable={false} />
        <span data-tauri-drag-region className="text-[13px] font-semibold tracking-tight">
          Wmux
        </span>
        {ws && (
          <>
            <span data-tauri-drag-region className="text-faint">
              /
            </span>
            <span data-tauri-drag-region className="flex min-w-0 items-center gap-1.5 text-muted">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: ws.color }} />
              <span data-tauri-drag-region className="truncate">
                {ws.name}
              </span>
            </span>
          </>
        )}
      </div>

      <div data-tauri-drag-region className="flex flex-1 justify-center px-4">
        <button
          type="button"
          onClick={() => setOverlay({ kind: "palette" })}
          className="flex h-6 w-full max-w-[420px] items-center gap-2 rounded-md border border-line bg-surface px-2 text-muted transition-colors hover:border-line-strong hover:text-fg"
        >
          <Search size={13} />
          <span className="flex-1 truncate text-left text-xs">Search commands, workspaces, shells…</span>
          <Kbd accelerator={paletteKey} />
        </button>
      </div>

      <div className="flex h-full items-center">
        <IconButton title="Settings (Ctrl+,)" onClick={() => setOverlay({ kind: "settings" })} className="mr-1">
          <Settings size={15} />
        </IconButton>
        <WindowButton title="Minimize" onClick={() => void win.minimize()}>
          <Minus size={15} />
        </WindowButton>
        <WindowButton title={maximized ? "Restore" : "Maximize"} onClick={() => void win.toggleMaximize()}>
          {maximized ? <Copy size={12} className="-scale-x-100" /> : <Square size={12} />}
        </WindowButton>
        <WindowButton title="Close" onClick={() => void win.close()} close>
          <X size={16} />
        </WindowButton>
      </div>
    </header>
  );
}

function WindowButton({
  title,
  onClick,
  children,
  close,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  close?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cx(
        "flex h-full w-11 items-center justify-center text-muted transition-colors",
        close ? "hover:bg-[#c42b1c] hover:text-white" : "hover:bg-hover hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}
