import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search } from "lucide-react";
import { fuzzyFilter } from "../lib/fuzzy";
import { errorMessage } from "../lib/ipc";
import { effectiveBindings, getCommands, type Command } from "../state/commands";
import { useStore } from "../state/store";
import { Kbd, cx } from "./ui";

export function CommandPalette({ initialQuery = "" }: { initialQuery?: string }) {
  const [query, setQuery] = useState(initialQuery);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const keybindings = useStore((s) => s.settings.keybindings);
  // Recompute dynamic entries when workspaces/profiles change.
  const workspaces = useStore((s) => s.workspaces);
  const profiles = useStore((s) => s.profiles);
  const close = () => useStore.getState().setOverlay(null);

  const bindings = useMemo(() => effectiveBindings(keybindings), [keybindings]);
  const all = useMemo(
    () => getCommands().filter((c) => !c.hidden),
    [workspaces, profiles],
  );
  const results = useMemo(() => fuzzyFilter(all, query, (c) => `${c.category}: ${c.title}`), [all, query]);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setSelected(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const run = async (cmd: Command | undefined) => {
    if (!cmd) return;
    close();
    try {
      await cmd.run();
    } catch (e) {
      useStore.getState().toast("error", `${cmd.title} failed: ${errorMessage(e)}`);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-40 flex justify-center bg-black/30 pt-[12vh]" onMouseDown={close}>
      <div
        role="dialog"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
        style={{ boxShadow: "var(--wm-shadow)" }}
        className="flex h-fit max-h-[60vh] w-[600px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border border-line-strong bg-elev"
      >
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search size={14} className="text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command…"
            aria-label="Command"
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelected((i) => Math.min(results.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelected((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                void run(results[selected]);
              } else if (e.key === "Escape") {
                close();
              }
            }}
            className="h-11 flex-1 bg-transparent text-[14px] outline-none placeholder:text-faint focus-visible:outline-none"
          />
        </div>
        <div ref={listRef} className="min-h-0 overflow-y-auto p-1" role="listbox">
          {results.length === 0 && <div className="px-3 py-6 text-center text-muted">No matching commands</div>}
          {results.map((cmd, i) => (
            <div
              key={cmd.id}
              data-index={i}
              role="option"
              aria-selected={i === selected}
              onMouseMove={() => setSelected(i)}
              onClick={() => void run(cmd)}
              className={cx(
                "flex cursor-pointer items-center gap-3 rounded-md px-3 py-1.5",
                i === selected ? "bg-active" : "",
              )}
            >
              <span className="w-20 shrink-0 text-[11px] text-faint">{cmd.category}</span>
              <span className="flex-1 truncate">{cmd.title}</span>
              <Kbd accelerator={bindings.get(cmd.id)} />
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
