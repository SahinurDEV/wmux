/** "horizontal" lays children out side by side; "vertical" stacks them. */
export type SplitDirection = "horizontal" | "vertical";

export type LayoutNode =
  | { type: "leaf"; id: string; paneId: string }
  | {
      type: "split";
      id: string;
      direction: SplitDirection;
      children: LayoutNode[];
      /** Percentages (0-100), same length as children, summing to ~100. */
      sizes: number[];
    };

export interface LastRun {
  pid: number | null;
  program: string | null;
  startedAt: number | null;
  exitCode: number | null;
  exitedAt: number | null;
}

export interface TerminalSurface {
  id: string;
  kind: "terminal";
  title: string;
  customTitle: boolean;
  shellProfileId: string | null;
  /** Start directory; updated from shell cwd reports so restore reopens there. */
  cwd: string | null;
  /** Facts about the process from the previous app session (read-only). */
  lastRun?: LastRun | null;
}

export type Surface = TerminalSurface;

export interface Pane {
  id: string;
  surfaces: Surface[];
  activeSurfaceId: string | null;
}

export interface Workspace {
  id: string;
  name: string;
  color: string;
  icon: string | null;
  cwd: string | null;
  pinned: boolean;
  layout: LayoutNode;
  focusedPaneId: string | null;
  shellProfileId: string | null;
  startupCommands: string[];
  env: Record<string, string>;
  panes: Pane[];
  createdAt: number;
}

export type TerminalStatus = "idle" | "starting" | "running" | "exited" | "error";

/** Live, non-persisted state of a terminal surface. */
export interface TerminalRuntime {
  status: TerminalStatus;
  pid?: number;
  exitCode?: number | null;
  error?: string;
  cwd?: string;
  profileName?: string;
}

export interface ShellProfile {
  id: string;
  name: string;
  kind: "pwsh" | "windowsPowershell" | "cmd" | "wsl" | "gitBash" | "custom";
  program: string;
  args: string[];
}

export interface UiState {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
}
