import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { useStore } from "../state/store";
import { cx } from "./ui";

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed right-4 bottom-9 z-50 flex w-[380px] max-w-[calc(100vw-32px)] flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === "error" ? "alert" : "status"}
          style={{ boxShadow: "var(--wm-shadow)" }}
          className="pointer-events-auto flex items-start gap-2 rounded-lg border border-line-strong bg-elev px-3 py-2 text-[13px]"
        >
          {t.kind === "error" ? (
            <CircleAlert size={15} className="mt-0.5 shrink-0 text-danger" />
          ) : t.kind === "success" ? (
            <CircleCheck size={15} className="mt-0.5 shrink-0 text-success" />
          ) : (
            <Info size={15} className="mt-0.5 shrink-0 text-accent" />
          )}
          <span className={cx("flex-1 break-words select-text")}>{t.message}</span>
          <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)} className="text-muted hover:text-fg">
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
