import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { acceleratorParts } from "../state/commands";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function IconButton({
  title,
  onClick,
  children,
  active,
  className,
  danger,
}: {
  title: string;
  onClick: (e: React.MouseEvent) => void;
  children: ReactNode;
  active?: boolean;
  className?: string;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cx(
        "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors",
        danger ? "hover:bg-danger/15 hover:text-danger" : "hover:bg-hover hover:text-fg",
        active && "bg-active text-fg",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Kbd({ accelerator }: { accelerator?: string }) {
  if (!accelerator) return null;
  return (
    <span className="flex gap-0.5">
      {acceleratorParts(accelerator).map((p, i) => (
        <kbd key={i} className="wm-kbd">
          {p}
        </kbd>
      ))}
    </span>
  );
}

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
  separator?: boolean;
  /** Custom content rendered instead of a button (e.g. color swatches). */
  custom?: ReactNode;
}

/** Positioned popup menu rendered in a portal; closes on outside click / Escape. */
export function Menu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.min(x, window.innerWidth - r.width - 8),
      y: Math.min(y, window.innerHeight - r.height - 8),
    });
  }, [x, y]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{ left: pos.x, top: pos.y, boxShadow: "var(--wm-shadow)" }}
      className="fixed z-50 min-w-48 rounded-lg border border-line-strong bg-elev p-1 text-[13px]"
    >
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="my-1 h-px bg-line" />
        ) : item.custom ? (
          <div key={i}>{item.custom}</div>
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect?.();
            }}
            className={cx(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left disabled:opacity-40",
              item.danger ? "text-danger hover:bg-danger/12" : "hover:bg-hover",
            )}
          >
            <span className="flex w-4 justify-center text-muted">{item.icon}</span>
            <span className="flex-1">{item.label}</span>
            {item.hint && <span className="text-xs text-faint">{item.hint}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

export function useMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const open = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };
  const element = menu ? <Menu {...menu} onClose={() => setMenu(null)} /> : null;
  return { open, element };
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 560,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/40 pt-[9vh]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        style={{ width, boxShadow: "var(--wm-shadow)" }}
        className="flex max-h-[80vh] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border border-line-strong bg-elev"
      >
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-line px-4">
          <h2 className="text-[13px] font-semibold">{title}</h2>
          <IconButton title="Close" onClick={onClose}>
            <X size={15} />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
        {footer && <div className="flex shrink-0 justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Button({
  children,
  onClick,
  primary,
  disabled,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "h-7 rounded-md px-3 text-[13px] font-medium transition-colors disabled:opacity-50",
        primary ? "bg-accent text-white hover:brightness-110" : "border border-line-strong hover:bg-hover",
      )}
      style={primary ? { color: "#fff" } : undefined}
    >
      {children}
    </button>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative h-[18px] w-8 shrink-0 rounded-full transition-colors",
        checked ? "bg-accent" : "bg-line-strong",
      )}
    >
      <span
        className={cx(
          "absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all",
          checked ? "left-[16px]" : "left-[2px]",
        )}
      />
    </button>
  );
}

export const inputClass =
  "h-7 w-full rounded-md border border-line-strong bg-surface px-2 text-[13px] text-fg outline-none focus:border-accent";
