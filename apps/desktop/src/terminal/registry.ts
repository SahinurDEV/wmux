// Terminal registry: owns one xterm.js instance and one ConPTY session per
// terminal surface, independent of React's component lifecycle. Components
// merely attach/detach the terminal's DOM host, so switching workspaces or
// re-rendering layouts never kills shells or loses scrollback.
import { Terminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { errorMessage, ipc, type RestoreRecord, type TerminalState } from "../lib/ipc";
import { onSurfacesRemoved, findSurface, useStore } from "../state/store";
import { paneIds } from "../state/layout";
import type { Settings } from "../state/settings";
import { parseOsc7, parseOsc9 } from "./osc";
import { parseShellReport, restoreAction, WMUX_OSC } from "./restore";
import { darkTerminalTheme, lightTerminalTheme } from "./themes";

type QueueItem = { kind: "text"; data: string } | { kind: "binary"; data: number[] };

interface Entry {
  surfaceId: string;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  serializer: SerializeAddon;
  host: HTMLDivElement;
  opened: boolean;
  webgl: WebglAddon | null;
  /** Incremented per spawn; events from older sessions are ignored. */
  generation: number;
  state: "idle" | "starting" | "running" | "exited";
  everStarted: boolean;
  queue: QueueItem[];
  pumping: boolean;
  resizeTimer?: number;
  observer: ResizeObserver;
  disposables: IDisposable[];
  /** Saved state from the previous app session has been applied (or there was none). */
  restored: boolean;
  /** Buffer changed since it was last saved. */
  dirty: boolean;
  /** Command the shell reported as running (null at the prompt). */
  runningCommand: string | null;
  /** `runningCommand` as last written to the database. */
  savedCommand: string | null;
  /** Pending "the command finished" (see COMMAND_CLEAR_GRACE_MS). */
  clearTimer?: number;
}

const entries = new Map<string, Entry>();
const startupRanFor = new Set<string>();
let appearance: { settings: Settings; dark: boolean } | null = null;

/** How often changed terminals are written to the database. */
const SAVE_INTERVAL_MS = 10_000;
/** Delay before a changed running command is written. */
const COMMAND_SAVE_DEBOUNCE_MS = 800;
/**
 * When the PC shuts down, Windows may kill a running command a moment before
 * Wmux itself; the shell then shows its prompt and reports "idle". Waiting
 * before believing that keeps the command remembered for the next start.
 */
const COMMAND_CLEAR_GRACE_MS = 3_000;
/** Lines of history kept per terminal, and a size bound for the saved text. */
/** Wait for the new shell to draw its first prompt before revealing history. */
const RESTORE_REVEAL_DELAY_MS = 900;
const SAVE_MAX_LINES = 5_000;
const SAVE_MAX_CHARS = 1_200_000;

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function store() {
  return useStore.getState();
}

function themeFor(dark: boolean) {
  return dark ? darkTerminalTheme : lightTerminalTheme;
}

// --------------------------------------------------------------- creation

function create(surfaceId: string): Entry {
  const s = appearance?.settings ?? store().settings;
  const term = new Terminal({
    allowProposedApi: true,
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    lineHeight: s.lineHeight,
    cursorStyle: s.cursorStyle,
    cursorBlink: s.cursorBlink,
    scrollback: s.scrollback,
    theme: themeFor(appearance?.dark ?? true),
    allowTransparency: false,
    macOptionIsMeta: false,
    rightClickSelectsWord: false,
    drawBoldTextInBrightColors: true,
    // ConPTY performs its own line wrapping/reflow semantics.
    windowsPty: { backend: "conpty" },
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  const serializer = new SerializeAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(serializer);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      event.preventDefault();
      if (/^https?:\/\//i.test(uri)) {
        openUrl(uri).catch((e) => store().toast("error", `Could not open link: ${errorMessage(e)}`));
      }
    }),
  );

  const host = document.createElement("div");
  host.className = "wmux-term-host";
  host.dataset.surfaceId = surfaceId;

  const entry: Entry = {
    surfaceId,
    term,
    fit,
    search,
    serializer,
    host,
    opened: false,
    webgl: null,
    generation: 0,
    state: "idle",
    everStarted: false,
    queue: [],
    pumping: false,
    observer: new ResizeObserver(() => scheduleFit(entry)),
    disposables: [],
    restored: false,
    dirty: false,
    runningCommand: null,
    savedCommand: null,
  };

  entry.disposables.push(
    term.onData((data) => {
      if (entry.state === "exited") {
        if (data === "\r") void restart(surfaceId);
        return;
      }
      enqueue(entry, { kind: "text", data });
    }),
    term.onBinary((data) => {
      if (entry.state !== "running") return;
      enqueue(entry, { kind: "binary", data: Array.from(data, (c) => c.charCodeAt(0) & 0xff) });
    }),
    term.onResize(({ cols, rows }) => {
      if (entry.state !== "running") return;
      window.clearTimeout(entry.resizeTimer);
      entry.resizeTimer = window.setTimeout(() => {
        ipc.ptyResize(surfaceId, cols, rows).catch(() => {
          /* session may have exited between events */
        });
      }, 25);
    }),
    term.onTitleChange((title) => {
      const clean = title.trim();
      // Shells title themselves with their full exe path; show just the name.
      const exe = /^[A-Za-z]:\\.*\\([^\\]+)\.exe$/i.exec(clean);
      if (clean) store().renameSurface(surfaceId, exe ? exe[1]! : clean, false);
    }),
    term.onSelectionChange(() => {
      if (store().settings.copyOnSelect && term.hasSelection()) {
        void writeText(term.getSelection()).catch(() => undefined);
      }
    }),
    term.parser.registerOscHandler(9, (data) => {
      const cwd = parseOsc9(data);
      if (cwd) store().setSurfaceCwd(surfaceId, cwd);
      return false; // let other handlers (e.g. progress) see it too
    }),
    term.parser.registerOscHandler(WMUX_OSC, (data) => {
      const report = parseShellReport(data);
      if (report?.type === "command") setRunningCommand(entry, report.command);
      else if (report?.type === "prompt") commandFinished(entry);
      return true;
    }),
    term.onWriteParsed(() => {
      entry.dirty = true;
    }),
    term.parser.registerOscHandler(7, (data) => {
      const cwd = parseOsc7(data);
      if (cwd) store().setSurfaceCwd(surfaceId, cwd);
      return true;
    }),
  );

  term.attachCustomKeyEventHandler((e) => handleClipboardKeys(entry, e));
  host.addEventListener("contextmenu", (e) => {
    // Windows Terminal convention: right-click copies a selection, otherwise pastes.
    e.preventDefault();
    if (term.hasSelection()) void copySelection(entry);
    else void paste(entry);
  });

  entries.set(surfaceId, entry);
  return entry;
}

function handleClipboardKeys(entry: Entry, e: KeyboardEvent): boolean {
  if (e.type !== "keydown") return true;
  const ctrl = e.ctrlKey && !e.altKey && !e.metaKey;
  const key = e.key.toLowerCase();
  if (ctrl && key === "c" && entry.term.hasSelection()) {
    e.preventDefault();
    void copySelection(entry);
    return false;
  }
  if ((ctrl && key === "v") || (e.shiftKey && e.key === "Insert")) {
    // Prevent the native paste event too, otherwise text is pasted twice.
    e.preventDefault();
    void paste(entry);
    return false;
  }
  if (ctrl && e.shiftKey && key === "c") {
    e.preventDefault();
    void copySelection(entry);
    return false;
  }
  return true;
}

async function copySelection(entry: Entry) {
  const text = entry.term.getSelection();
  if (!text) return;
  try {
    await writeText(text);
    entry.term.clearSelection();
  } catch (e) {
    store().toast("error", `Copy failed: ${errorMessage(e)}`);
  }
}

async function paste(entry: Entry) {
  try {
    const text = await readText();
    if (text) entry.term.paste(text); // honors bracketed paste mode
  } catch (e) {
    store().toast("error", `Paste failed: ${errorMessage(e)}`);
  }
}

// ------------------------------------------------------------------ input

function enqueue(entry: Entry, item: QueueItem) {
  const last = entry.queue.at(-1);
  if (item.kind === "text" && last?.kind === "text") last.data += item.data;
  else entry.queue.push(item);
  if (!entry.pumping) void pump(entry);
}

/** Send queued input strictly in order, one IPC call at a time. */
async function pump(entry: Entry) {
  entry.pumping = true;
  try {
    while (entry.queue.length) {
      const item = entry.queue.shift()!;
      try {
        if (item.kind === "text") await ipc.ptyWrite(entry.surfaceId, item.data);
        else await ipc.ptyWriteBinary(entry.surfaceId, item.data);
      } catch (e) {
        entry.queue.length = 0;
        if (entry.state === "running") store().toast("error", `Terminal input failed: ${errorMessage(e)}`);
      }
    }
  } finally {
    entry.pumping = false;
  }
}

// ----------------------------------------------------------- attach / fit

function scheduleFit(entry: Entry) {
  requestAnimationFrame(() => fitNow(entry));
}

function fitNow(entry: Entry) {
  if (!entry.opened || !entry.host.isConnected) return;
  const { clientWidth, clientHeight } = entry.host;
  if (clientWidth < 10 || clientHeight < 10) return; // hidden
  try {
    entry.fit.fit();
  } catch {
    /* renderer not ready yet */
  }
}

function enableWebgl(entry: Entry) {
  if (entry.webgl || !(appearance?.settings ?? store().settings).gpuRendering) return;
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl.dispose();
      entry.webgl = null;
    });
    entry.term.loadAddon(webgl);
    entry.webgl = webgl;
  } catch {
    entry.webgl = null; // fall back to the DOM renderer
  }
}

export function attach(surfaceId: string, container: HTMLElement) {
  const entry = entries.get(surfaceId) ?? create(surfaceId);
  if (entry.host.parentElement !== container) container.appendChild(entry.host);
  if (!entry.opened) {
    entry.term.open(entry.host);
    entry.opened = true;
    enableWebgl(entry);
  }
  entry.observer.observe(entry.host);
  fitNow(entry);
  if (entry.state === "idle") void start(surfaceId);
}

export function detach(surfaceId: string, container: HTMLElement) {
  const entry = entries.get(surfaceId);
  if (!entry) return;
  entry.observer.unobserve(entry.host);
  if (entry.host.parentElement === container) container.removeChild(entry.host);
}

// ------------------------------------------------------- session restore

function setRunningCommand(entry: Entry, command: string | null) {
  window.clearTimeout(entry.clearTimer);
  entry.clearTimer = undefined;
  if (entry.runningCommand === command) return;
  entry.runningCommand = command;
  scheduleCommandSave();
}

/** The shell is back at its prompt: forget the command, after a grace period. */
function commandFinished(entry: Entry) {
  if (entry.runningCommand === null || entry.clearTimer !== undefined) return;
  entry.clearTimer = window.setTimeout(() => setRunningCommand(entry, null), COMMAND_CLEAR_GRACE_MS);
}

/** Serialized buffer for saving, or null if it cannot be kept within bounds. */
function serializeBuffer(entry: Entry): string | null {
  let lines = Math.min(store().settings.scrollback, SAVE_MAX_LINES);
  for (let attempt = 0; attempt < 5; attempt++) {
    // Modes (mouse reporting, bracketed paste...) and full-screen apps belong
    // to the old process; only the normal screen text is worth bringing back.
    const data = entry.serializer.serialize({ scrollback: lines, excludeModes: true, excludeAltBuffer: true });
    if (data.length <= SAVE_MAX_CHARS) return data;
    lines = Math.floor(lines / 2);
  }
  return null;
}

let commandSaveTimer: number | undefined;
let stateSaving: Promise<void> = Promise.resolve();
let reportedSaveError = false;
/**
 * Set once the final save before closing has been made. From then on the
 * terminals are being torn down, and what they report ("the command ended")
 * describes the shutdown, not what should be restored next time.
 */
let closed = false;

function scheduleCommandSave() {
  window.clearTimeout(commandSaveTimer);
  commandSaveTimer = window.setTimeout(() => void saveState(false), COMMAND_SAVE_DEBOUNCE_MS);
}

/**
 * Write changed terminals to the database. `includeScrollback` also saves the
 * text of terminals whose buffer changed; otherwise only running commands.
 */
function saveState(includeScrollback: boolean): Promise<void> {
  stateSaving = stateSaving.then(async () => {
    if (closed) return;
    const keepText = store().settings.restoreScrollback;
    const items: TerminalState[] = [];
    const saved: Array<{ entry: Entry; text: boolean; command: string | null }> = [];
    for (const entry of entries.values()) {
      // Never overwrite saved state before it has been restored into this terminal.
      if (!entry.restored) continue;
      const text = includeScrollback && entry.dirty;
      if (!text && entry.runningCommand === entry.savedCommand) continue;
      const item: TerminalState = { surfaceId: entry.surfaceId, runningCommand: entry.runningCommand };
      if (text) item.scrollback = keepText ? (serializeBuffer(entry) ?? "") : "";
      items.push(item);
      saved.push({ entry, text, command: entry.runningCommand });
      if (text) entry.dirty = false;
    }
    if (items.length === 0) return;
    try {
      await ipc.terminalStateSave(items);
      for (const s of saved) s.entry.savedCommand = s.command;
      reportedSaveError = false;
    } catch (e) {
      for (const s of saved) if (s.text) s.entry.dirty = true;
      if (!reportedSaveError) store().toast("error", `Could not save terminal history: ${errorMessage(e)}`);
      reportedSaveError = true;
    }
  });
  return stateSaving;
}

window.setInterval(() => void saveState(true), SAVE_INTERVAL_MS);

/** Save every terminal now (before the window closes). */
export function flushState(): Promise<void> {
  window.clearTimeout(commandSaveTimer);
  // A deliberate close: commands that already returned to the prompt are done.
  for (const entry of entries.values()) {
    if (entry.clearTimer !== undefined) setRunningCommand(entry, null);
  }
  window.clearTimeout(commandSaveTimer);
  return saveState(true).then(() => {
    closed = true;
  });
}

/** Write `data` and wait until xterm has processed it. */
function writeAndWait(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

/**
 * Replay the text saved by the previous app session, followed by a note about
 * what is being started again. Everything ends up in the scrollback, directly
 * above an empty screen: ConPTY starts every new shell by clearing the screen
 * and drawing from the top-left, which would otherwise wipe the restored text.
 */
async function replayScrollback(entry: Entry, scrollback: string | null, notice: string | null) {
  const { term } = entry;
  if (scrollback) {
    await writeAndWait(term, scrollback);
    const when = new Date().toLocaleString();
    await writeAndWait(term, `\x1b[0m\r\n${DIM}── session restored · ${when} ──${RESET}\r\n`);
  }
  if (notice) await writeAndWait(term, `${DIM}↻ ${notice}${RESET}\r\n`);
  const used = term.buffer.active.cursorY;
  if (used > 0) await writeAndWait(term, `\x1b[${term.rows};1H${"\n".repeat(used)}`);
  await writeAndWait(term, "\x1b[H");
}

/** Load what was saved for this terminal; never fails the start. */
async function loadRestore(surfaceId: string): Promise<RestoreRecord | null> {
  try {
    return await ipc.terminalRestoreGet(surfaceId);
  } catch (e) {
    store().toast("error", `Could not load terminal history: ${errorMessage(e)}`);
    return null;
  }
}

// -------------------------------------------------------------- lifecycle

export async function start(surfaceId: string): Promise<void> {
  const entry = entries.get(surfaceId);
  if (!entry || entry.state === "starting" || entry.state === "running") return;
  const found = findSurface(store().workspaces, surfaceId);
  if (!found) return;
  const { ws, surface } = found;
  const s = store();

  entry.state = "starting";
  const generation = ++entry.generation;
  s.setRuntime(surfaceId, { status: "starting", error: undefined, exitCode: undefined });
  fitNow(entry);

  // First start of this terminal in this app session: bring back what the
  // previous session saved (text, agent conversation, running command).
  let action: ReturnType<typeof restoreAction> = null;
  let agentCwd: string | null = null;
  let replayedText = false;
  if (!entry.restored) {
    const saved = await loadRestore(surfaceId);
    if (entry.generation !== generation) return;
    if (saved) {
      action = restoreAction(saved, s.settings);
      const notice = action && `${action.kind === "agent" ? "Resuming agent session" : "Re-running"}: ${action.command}`;
      replayedText = s.settings.restoreScrollback && !!saved.scrollback;
      await replayScrollback(entry, replayedText ? saved.scrollback : null, notice);
      if (action?.kind === "agent") agentCwd = saved.agent?.cwd ?? null;
      // Keep the command remembered until the new shell reports for itself.
      if (action?.kind === "command") {
        entry.runningCommand = action.command;
        entry.savedCommand = saved.runningCommand;
      }
    }
    entry.restored = true;
    if (entry.generation !== generation) return;
  }

  try {
    const result = await ipc.ptySpawn(
      {
        surfaceId,
        workspaceId: ws.id,
        profileId: surface.shellProfileId ?? ws.shellProfileId ?? s.settings.defaultShellProfileId,
        // An agent conversation belongs to the directory it was started in.
        cwd: agentCwd ?? surface.cwd ?? ws.cwd,
        env: ws.env,
        cols: Math.max(entry.term.cols, 2),
        rows: Math.max(entry.term.rows, 2),
        shellIntegration: s.settings.shellIntegration,
      },
      (ev) => {
        if (entry.generation !== generation) return; // stale session
        if (ev.type === "output") {
          entry.term.write(ev.data);
        } else {
          entry.state = "exited";
          // Same grace as a prompt: at shutdown the shell may die just before Wmux.
          commandFinished(entry);
          store().setRuntime(surfaceId, { status: "exited", exitCode: ev.code });
          const code = ev.code === null ? "unknown" : String(ev.code);
          entry.term.write(
            `\r\n${DIM}[process exited with code ${code}] Press Enter to restart.${RESET}\r\n`,
          );
        }
      },
    );
    if (entry.generation !== generation) return;
    // The exit event may already have arrived for very short-lived commands.
    if (entry.state === "starting") entry.state = "running";
    entry.everStarted = true;
    // Re-read: the exit callback may have run while awaiting the spawn.
    const exited = (entry.state as Entry["state"]) === "exited";
    store().setRuntime(surfaceId, {
      status: exited ? "exited" : "running",
      pid: result.session.pid,
      profileName: result.profile.name,
      cwd: result.cwd ?? undefined,
    });
    if (result.cwdFallbackFrom) {
      entry.term.writeln(`${DIM}Directory not found: ${result.cwdFallbackFrom}. Started in ${result.cwd ?? "home"}.${RESET}`);
    }
    // Sync the size in case the pane was resized while spawning.
    fitNow(entry);
    if (!exited) {
      void ipc.ptyResize(surfaceId, entry.term.cols, entry.term.rows).catch(() => undefined);
    }
    runStartupCommands(entry, ws.id);
    if (action && !exited) enqueue(entry, { kind: "text", data: `${action.command}\r` });
    // An idle restored terminal opens looking the way it was left: scrolled so
    // the restored text fills the pane with the new prompt below it. (The first
    // keystroke or new output returns to the live screen.) When something is
    // being started again, its live output is what matters, so stay put.
    if (replayedText && !action && !exited) {
      window.setTimeout(() => {
        if (entry.generation === generation && entry.state === "running") {
          entry.term.scrollLines(-Math.max(entry.term.rows - 3, 0));
        }
      }, RESTORE_REVEAL_DELAY_MS);
    }
  } catch (e) {
    if (entry.generation !== generation) return;
    entry.state = "exited";
    const message = errorMessage(e);
    store().setRuntime(surfaceId, { status: "error", error: message });
    entry.term.writeln(`\x1b[31mFailed to start shell: ${message}${RESET}`);
    entry.term.writeln(`${DIM}Press Enter to retry, or pick another shell from the tab menu.${RESET}`);
  }
}

/** Run workspace startup commands once, in the first terminal of the workspace. */
function runStartupCommands(entry: Entry, workspaceId: string) {
  if (startupRanFor.has(workspaceId)) return;
  const ws = store().workspaces.find((w) => w.id === workspaceId);
  if (!ws) return;
  const firstPane = ws.panes.find((p) => p.id === paneIds(ws.layout)[0]);
  if (firstPane?.surfaces[0]?.id !== entry.surfaceId) return;
  startupRanFor.add(workspaceId);
  for (const cmd of ws.startupCommands) {
    if (cmd.trim()) enqueue(entry, { kind: "text", data: `${cmd}\r` });
  }
}

export async function restart(surfaceId: string): Promise<void> {
  const entry = entries.get(surfaceId);
  if (!entry) return;
  entry.generation++; // ignore any further events from the old process
  entry.queue.length = 0;
  try {
    await ipc.ptyClose(surfaceId);
  } catch (e) {
    store().toast("error", `Could not stop the old process: ${errorMessage(e)}`);
  }
  entry.state = "idle";
  entry.term.reset();
  await start(surfaceId);
}

export async function kill(surfaceId: string): Promise<void> {
  try {
    await ipc.ptyKill(surfaceId);
  } catch (e) {
    store().toast("error", `Kill failed: ${errorMessage(e)}`);
  }
}

export function clear(surfaceId: string) {
  entries.get(surfaceId)?.term.clear();
}

export function focus(surfaceId: string) {
  entries.get(surfaceId)?.term.focus();
}

export function getSearch(surfaceId: string): SearchAddon | undefined {
  return entries.get(surfaceId)?.search;
}

export function selectAll(surfaceId: string) {
  entries.get(surfaceId)?.term.selectAll();
}

export function dispose(surfaceId: string) {
  const entry = entries.get(surfaceId);
  entries.delete(surfaceId);
  void ipc.ptyClose(surfaceId).catch(() => undefined);
  if (!entry) return;
  entry.generation++;
  entry.observer.disconnect();
  window.clearTimeout(entry.resizeTimer);
  window.clearTimeout(entry.clearTimer);
  entry.disposables.forEach((d) => d.dispose());
  entry.webgl?.dispose();
  entry.term.dispose();
  entry.host.remove();
}

/** Apply appearance settings to every live terminal. */
export function applyAppearance(settings: Settings, dark: boolean) {
  appearance = { settings, dark };
  for (const entry of entries.values()) {
    const o = entry.term.options;
    o.fontFamily = settings.fontFamily;
    o.fontSize = settings.fontSize;
    o.lineHeight = settings.lineHeight;
    o.cursorStyle = settings.cursorStyle;
    o.cursorBlink = settings.cursorBlink;
    o.scrollback = settings.scrollback;
    o.theme = themeFor(dark);
    if (settings.gpuRendering) {
      if (entry.opened) enableWebgl(entry);
    } else if (entry.webgl) {
      entry.webgl.dispose();
      entry.webgl = null;
    }
    scheduleFit(entry);
  }
}

/** Text content of a terminal buffer (used by E2E tests and future search UI). */
export function bufferText(surfaceId: string): string {
  const entry = entries.get(surfaceId);
  if (!entry) return "";
  const buf = entry.term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
  return lines.join("\n");
}

onSurfacesRemoved((ids) => ids.forEach(dispose));
