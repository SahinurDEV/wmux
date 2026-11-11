import { Circle, Folder, Layers, SquareTerminal } from "lucide-react";
import { focusedSurfaceId } from "../state/actions";
import { activeWorkspace, findSurface, useStore } from "../state/store";
import { cx } from "./ui";

export function StatusBar() {
  // Subscribe to the pieces that affect the focused terminal.
  const workspaces = useStore((s) => s.workspaces);
  useStore((s) => activeWorkspace(s)?.focusedPaneId);
  useStore((s) => s.zoomedPaneId);
  const runtime = useStore((s) => s.runtime);
  const version = useStore((s) => s.appInfo?.version);

  const surfaceId = focusedSurfaceId();
  const found = surfaceId ? findSurface(workspaces, surfaceId) : undefined;
  const rt = surfaceId ? runtime[surfaceId] : undefined;
  const cwd = rt?.cwd ?? found?.surface.cwd ?? found?.ws.cwd;
  const running = Object.values(runtime).filter((r) => r.status === "running").length;

  let statusLabel = "No terminal";
  let statusClass = "text-faint";
  if (rt) {
    switch (rt.status) {
      case "running":
        statusLabel = "Running";
        statusClass = "text-success";
        break;
      case "starting":
        statusLabel = "Starting…";
        statusClass = "text-warning";
        break;
      case "exited":
        statusLabel = `Exited (${rt.exitCode ?? "?"})`;
        statusClass = rt.exitCode === 0 ? "text-muted" : "text-warning";
        break;
      case "error":
        statusLabel = "Failed to start";
        statusClass = "text-danger";
        break;
      default:
        statusLabel = "Idle";
    }
  }

  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-line bg-panel px-3 text-[11px] text-muted">
      <span className="flex min-w-0 items-center gap-1.5" title={rt?.error ?? undefined}>
        <Circle size={7} className={cx("fill-current", statusClass)} />
        <span className={statusClass}>{statusLabel}</span>
      </span>
      {cwd && (
        <span className="flex min-w-0 items-center gap-1.5" title={cwd}>
          <Folder size={12} className="shrink-0" />
          <span className="truncate">{cwd}</span>
        </span>
      )}
      {rt?.profileName && (
        <span className="flex shrink-0 items-center gap-1.5">
          <SquareTerminal size={12} />
          {rt.profileName}
          {rt.pid ? <span className="text-faint">PID {rt.pid}</span> : null}
        </span>
      )}
      <span className="flex-1" />
      <span className="flex shrink-0 items-center gap-1.5" title="Running terminal processes">
        <SquareTerminal size={12} />
        {running} running
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <Layers size={12} />
        {workspaces.length} workspace{workspaces.length === 1 ? "" : "s"}
      </span>
      {version && <span className="shrink-0 text-faint">v{version}</span>}
    </footer>
  );
}
