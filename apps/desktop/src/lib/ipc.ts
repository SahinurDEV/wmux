// Typed wrappers around the Rust commands in src-tauri/src/commands.rs.
import { Channel, invoke } from "@tauri-apps/api/core";
import type { LastRun, ShellProfile } from "../state/types";

export interface CmdError {
  kind: string;
  message: string;
}

export function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as CmdError).message);
  return String(e);
}

export interface AppInfo {
  version: string;
  dbPath: string;
  dbRecoveredFrom: string | null;
  dbRecoveryReason: string | null;
  e2e: boolean;
  homeDir: string | null;
}

export interface SessionInfo {
  id: string;
  pid: number;
  program: string;
  startedAtMs: number;
  exitCode: number | null;
  running: boolean;
}

export interface SpawnRequest {
  surfaceId: string;
  workspaceId: string;
  profileId: string | null;
  cwd: string | null;
  env: Record<string, string>;
  cols: number;
  rows: number;
  shellIntegration: boolean;
}

export interface SpawnResult {
  session: SessionInfo;
  profile: ShellProfile;
  cwd: string | null;
  cwdFallbackFrom: string | null;
}

export type PtyEvent = { type: "output"; data: Uint8Array } | { type: "exit"; code: number | null };

// Snapshot shapes mirror crates/session-manager (camelCase via serde).
export interface SurfaceRecord {
  id: string;
  kind: "terminal";
  title: string;
  customTitle: boolean;
  shellProfileId: string | null;
  cwd: string | null;
  lastRun?: LastRun | null;
}
export interface PaneRecord {
  id: string;
  activeSurfaceId: string | null;
  surfaces: SurfaceRecord[];
}
export interface WorkspaceRecord {
  id: string;
  name: string;
  color: string;
  icon: string | null;
  cwd: string | null;
  pinned: boolean;
  layout: unknown;
  focusedPaneId: string | null;
  shellProfileId: string | null;
  startupCommands: string[];
  env: Record<string, string>;
  panes: PaneRecord[];
  createdAt: number;
}
export interface SessionSnapshot {
  workspaces: WorkspaceRecord[];
  activeWorkspaceId: string | null;
  ui: unknown;
}

const TAG_OUTPUT = 0;
const TAG_EXIT = 1;
const decoder = new TextDecoder();

/** Decode a tagged message from the PTY channel (see commands.rs). */
export function decodePtyMessage(raw: unknown): PtyEvent | null {
  let bytes: Uint8Array;
  if (raw instanceof ArrayBuffer) bytes = new Uint8Array(raw);
  else if (raw instanceof Uint8Array) bytes = raw;
  else if (Array.isArray(raw)) bytes = Uint8Array.from(raw as number[]);
  else return null;
  if (bytes.length === 0) return null;
  const body = bytes.subarray(1);
  if (bytes[0] === TAG_OUTPUT) return { type: "output", data: body };
  if (bytes[0] === TAG_EXIT) {
    try {
      const parsed = JSON.parse(decoder.decode(body)) as { code: number | null };
      return { type: "exit", code: parsed.code };
    } catch {
      return { type: "exit", code: null };
    }
  }
  return null;
}

export const ipc = {
  appInfo: () => invoke<AppInfo>("app_info"),
  listShellProfiles: () => invoke<ShellProfile[]>("list_shell_profiles"),

  ptySpawn: (request: SpawnRequest, onEvent: (e: PtyEvent) => void) => {
    const channel = new Channel<unknown>();
    channel.onmessage = (msg) => {
      const ev = decodePtyMessage(msg);
      if (ev) onEvent(ev);
    };
    return invoke<SpawnResult>("pty_spawn", { request, onEvent: channel });
  },
  ptyWrite: (id: string, data: string) => invoke<void>("pty_write", { id, data }),
  ptyWriteBinary: (id: string, data: number[]) => invoke<void>("pty_write_binary", { id, data }),
  ptyResize: (id: string, cols: number, rows: number) => invoke<void>("pty_resize", { id, cols, rows }),
  ptyKill: (id: string) => invoke<void>("pty_kill", { id }),
  ptyClose: (id: string) => invoke<void>("pty_close", { id }),
  ptyList: () => invoke<SessionInfo[]>("pty_list"),

  sessionLoad: () => invoke<SessionSnapshot>("session_load"),
  sessionSave: (snapshot: SessionSnapshot) => invoke<void>("session_save", { snapshot }),
  settingsGet: () => invoke<Record<string, unknown>>("settings_get"),
  settingsSet: (values: Record<string, unknown>) => invoke<void>("settings_set", { values }),
  dbBackup: () => invoke<string>("db_backup"),
};
