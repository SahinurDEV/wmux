// In-app updates: the state the UI shows. The actions are in updateActions.ts;
// the backend (src-tauri/src/updates.rs) downloads and verifies.
import type { UpdateInfo } from "../lib/ipc";

export interface UpdateState {
  status: "idle" | "checking" | "available" | "downloading" | "installing";
  info: UpdateInfo | null;
  /** Download progress from 0 to 1, when the size is known. */
  progress: number | null;
}

/** How often a running app looks for a new version. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** What the status bar button says, or null when there is nothing to show. */
export function updateLabel(u: UpdateState): string | null {
  if (!u.info) return null;
  switch (u.status) {
    case "downloading":
      return u.progress === null ? "Downloading update…" : `Downloading update… ${Math.round(u.progress * 100)}%`;
    case "installing":
      return "Installing update…";
    default:
      return u.info.canInstall ? `Update to v${u.info.version}` : `v${u.info.version} available`;
  }
}
