#!/usr/bin/env node
// DEV-ONLY visual preview of the frontend in Microsoft Edge with a *stubbed*
// Tauri IPC bridge. Used to screenshot layout/styling on machines that cannot
// run the native app (e.g. Smart App Control blocks unsigned local builds).
// Terminal output shown here is a canned banner from the stub, NOT a shell.
// Real behavior is verified by `cargo test` and tests/e2e/run.mjs.
//
// Usage (from apps/desktop): pnpm build:web && pnpm preview:ui
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preview } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "../../test-results/preview");
mkdirSync(out, { recursive: true });

const server = await preview({ root, preview: { port: 4173, strictPort: true }, logLevel: "warn" });

function stub() {
  const callbacks = new Map();
  let nextId = 1;
  const settings = {};
  let snapshot = { workspaces: [], activeWorkspaceId: null, ui: null };
  const enc = new TextEncoder();
  const banner = (cwd) =>
    "\x1b[2m[ui-preview stub — no real shell]\x1b[0m\r\n" +
    `\x1b[32mPS\x1b[0m ${cwd}> \x1b[33mgit\x1b[0m status\r\nOn branch \x1b[36mmain\x1b[0m\r\nnothing to commit, working tree clean\r\n` +
    `\x1b[32mPS\x1b[0m ${cwd}> `;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback(cb, once) {
      const id = nextId++;
      callbacks.set(id, cb);
      window[`_${id}`] = cb;
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    convertFileSrc: (p) => p,
    async invoke(cmd, args) {
      switch (cmd) {
        case "app_info":
          return { version: "0.1.0", dbPath: "C:\\Users\\dev\\AppData\\Roaming\\dev.wmux.desktop\\wmux.db", dbRecoveredFrom: null, dbRecoveryReason: null, e2e: true, homeDir: "C:\\Users\\dev" };
        case "settings_get":
          return settings;
        case "settings_set":
          Object.assign(settings, args.values);
          return null;
        case "list_shell_profiles":
          return [
            { id: "pwsh", name: "PowerShell 7", kind: "pwsh", program: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", args: ["-NoLogo"] },
            { id: "powershell", name: "Windows PowerShell", kind: "windowsPowershell", program: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", args: ["-NoLogo"] },
            { id: "cmd", name: "Command Prompt", kind: "cmd", program: "C:\\Windows\\System32\\cmd.exe", args: [] },
            { id: "gitbash", name: "Git Bash", kind: "gitBash", program: "C:\\Program Files\\Git\\bin\\bash.exe", args: ["--login", "-i"] },
          ];
        case "session_load":
          return snapshot;
        case "session_save":
          snapshot = args.snapshot;
          return null;
        case "pty_spawn": {
          const cwd = args.request.cwd ?? "C:\\Users\\dev\\src\\wmux";
          const ch = args.onEvent;
          setTimeout(() => {
            const body = enc.encode(banner(cwd));
            const msg = new Uint8Array(body.length + 1);
            msg.set(body, 1);
            window[`_${ch.id}`]?.({ message: msg.buffer, index: 0 });
          }, 50);
          return { session: { id: args.request.surfaceId, pid: 10000 + nextId, program: "pwsh.exe", startedAtMs: Date.now(), exitCode: null, running: true }, profile: { id: "pwsh", name: "PowerShell 7", kind: "pwsh", program: "pwsh.exe", args: [] }, cwd, cwdFallbackFrom: null };
        }
        case "plugin:window|is_maximized":
          return false;
        case "plugin:event|listen":
          return nextId++;
        default:
          return null;
      }
    },
  };
}

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1360, height: 820 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("pageerror:", e.message));
page.on("console", (m) => m.type() === "error" && console.error("console:", m.text()));
await page.addInitScript(stub);
await page.goto("http://localhost:4173/");
await page.waitForFunction(() => window.__wmuxTest?.getState().loaded === true);

const run = (id) => page.evaluate((i) => window.__wmuxTest.runCommand(i), id);
const shot = async (name) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`saved ${name}.png`);
};

await page.evaluate(() => {
  const s = window.__wmuxTest.getState();
  s.updateWorkspace(s.activeWorkspaceId, { name: "wmux", cwd: "C:\\Users\\dev\\src\\wmux" });
});
await run("pane.splitRight");
await run("pane.splitDown");
await run("terminal.new");
await page.evaluate(() => {
  const s = window.__wmuxTest.getState();
  s.createWorkspace({ name: "api-server", cwd: "C:\\src\\api" });
  s.createWorkspace({ name: "docs-site", cwd: "C:\\src\\docs" });
  s.togglePin(s.workspaces[0].id);
  s.setActiveWorkspace(s.workspaces[0].id);
});
await shot("01-dark-splits");
await run("palette.show");
await page.keyboard.type("split");
await shot("02-palette");
await page.keyboard.press("Escape");
await run("settings.open");
await shot("03-settings");
await page.keyboard.press("Escape");
await run("view.themeToggle");
await shot("04-light");
await page.setViewportSize({ width: 760, height: 560 });
await shot("05-narrow");

await browser.close();
await server.close();
