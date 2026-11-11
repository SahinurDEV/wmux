// Terminal registry: owns one xterm.js instance and one ConPTY session per
// terminal surface, independent of React's component lifecycle. Components
// merely attach/detach the terminal's DOM host, so switching workspaces or
// re-rendering layouts never kills shells or loses scrollback.
import { Terminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { errorMessage, ipc } from "../lib/ipc";
import { onSurfacesRemoved, findSurface, useStore } from "../state/store";
import { paneIds } from "../state/layout";
import type { Settings } from "../state/settings";
import { parseOsc7, parseOsc9 } from "./osc";
import { darkTerminalTheme, lightTerminalTheme } from "./themes";

type QueueItem = { kind: "text"; data: string } | { kind: "binary"; data: number[] };

interface Entry {
  surfaceId: string;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
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
}

const entries = new Map<string, Entry>();
const startupRanFor = new Set<string>();
let appearance: { settings: Settings; dark: boolean } | null = null;

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
  term.loadAddon(fit);
  term.loadAddon(search);
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
      if (title.trim()) store().renameSurface(surfaceId, title.trim(), false);
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

  if (!entry.everStarted && surface.lastRun?.pid) {
    const prog = surface.lastRun.program?.split(/[\\/]/).pop() ?? "shell";
    entry.term.writeln(
      `${DIM}↻ Layout restored. The previous ${prog} (PID ${surface.lastRun.pid}) ended when Wmux closed; started a new session.${RESET}`,
    );
  }

  try {
    const result = await ipc.ptySpawn(
      {
        surfaceId,
        workspaceId: ws.id,
        profileId: surface.shellProfileId ?? ws.shellProfileId ?? s.settings.defaultShellProfileId,
        cwd: surface.cwd ?? ws.cwd,
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
