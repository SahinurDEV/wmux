// Checking for a new version and installing it.
import { openUrl } from "@tauri-apps/plugin-opener";
import { errorMessage, ipc } from "../lib/ipc";
import * as terminals from "../terminal/registry";
import { flushSave } from "./persistence";
import { useStore } from "./store";
import type { UpdateState } from "./updates";

const set = (update: Partial<UpdateState>) => useStore.setState((s) => ({ update: { ...s.update, ...update } }));

/**
 * Look for a new version. `manual` is true when the user asked: only then are
 * "up to date" and errors reported, so a background check never interrupts.
 */
export async function checkForUpdates(manual: boolean): Promise<void> {
  const { update, toast } = useStore.getState();
  if (update.status !== "idle" && update.status !== "available") return;
  set({ status: "checking" });
  try {
    const info = await ipc.updateCheck();
    set({ status: info ? "available" : "idle", info });
    if (manual) toast("info", info ? `Wmux ${info.version} is available.` : "Wmux is up to date.");
  } catch (e) {
    set({ status: update.info ? "available" : "idle" });
    if (manual) toast("error", `Could not check for updates: ${errorMessage(e)}`);
  }
}

/**
 * Install the update on offer. Terminals keep running during the download;
 * the session is saved just before the installer takes over, so it comes back
 * in the new version like after any restart.
 */
export async function installUpdate(): Promise<void> {
  const { update, toast } = useStore.getState();
  if (update.status !== "available" || !update.info) return;
  if (!update.info.canInstall) {
    await openUrl(update.info.downloadPage).catch((e) => toast("error", `Could not open the download page: ${errorMessage(e)}`));
    return;
  }
  set({ status: "downloading", progress: null });
  try {
    await ipc.updateDownload((progress) => set({ progress }));
  } catch (e) {
    set({ status: "available", progress: null });
    toast("error", `Update failed to download: ${errorMessage(e)}`);
    return;
  }
  set({ status: "installing" });
  // Layout first: terminal state rows are tied to the saved surfaces.
  await flushSave();
  await terminals.flushState();
  try {
    await ipc.updateInstall();
  } catch (e) {
    toast("error", `Update failed to install: ${errorMessage(e)}. Restart Wmux and try again.`);
  }
}
