#!/usr/bin/env node
// End-to-end test against the real, built Wmux application.
//
// The app is launched with WebView2's remote debugging enabled and driven via
// the Chrome DevTools Protocol using Playwright. Shell commands run in real
// ConPTY sessions; nothing is mocked. Data is written to a temporary
// directory (WMUX_DATA_DIR), so the user's real session is never touched.
//
// Usage: node tests/e2e/run.mjs <path-to-wmux-desktop.exe>
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";

const exe = resolve(process.argv[2] ?? "target/release/wmux-desktop.exe");
const dataDir = mkdtempSync(join(tmpdir(), "wmux-e2e-"));
const shots = resolve("test-results");
mkdirSync(shots, { recursive: true });

let step = 0;
const log = (msg) => console.log(`[e2e ${String(++step).padStart(2, "0")}] ${msg}`);

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function waitFor(fn, what, timeoutMs = 30_000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}

let current = null;

async function launch() {
  const port = 9300 + Math.floor(Math.random() * 500);
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      WMUX_E2E: "1",
      WMUX_DATA_DIR: dataDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const exited = new Promise((r) => child.on("exit", r));
  current = child;
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok, "WebView2 DevTools endpoint");
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await waitFor(
    () => browser.contexts().flatMap((c) => c.pages()).find((p) => /tauri\.localhost|localhost:1420/.test(p.url())),
    "app page",
  );
  await page.waitForFunction(() => window.__wmuxTest?.getState().loaded === true, null, { timeout: 30_000 });
  return { child, browser, page, exited };
}

const state = (page, expr) => page.evaluate(`(() => { const s = window.__wmuxTest.getState(); return ${expr}; })()`);

async function terminalText(page, surfaceId) {
  return page.evaluate((id) => window.__wmuxTest.bufferText(id), surfaceId);
}

async function focusedSurface(page) {
  return page.evaluate(() => window.__wmuxTest.focusedSurfaceId());
}

async function typeInTerminal(page, surfaceId, text) {
  await page.click(`[data-surface-id="${surfaceId}"] .xterm-screen`);
  await page.keyboard.type(text, { delay: 5 });
  await page.keyboard.press("Enter");
}

async function waitRunning(page, surfaceId) {
  await waitFor(() => state(page, `s.runtime[${JSON.stringify(surfaceId)}]?.status === "running"`), `terminal ${surfaceId} running`);
}

async function closeApp(app) {
  await app.page.click('header button[aria-label="Close"]');
  await Promise.race([app.exited, sleep(15_000).then(() => { throw new Error("app did not exit"); })]);
  await app.browser.close().catch(() => undefined);
}

async function main() {
  // ---------------------------------------------------------------- run 1
  log(`launching ${exe}`);
  let app = await launch();
  let { page } = app;

  const wsCount = await state(page, "s.workspaces.length");
  assert(wsCount === 1, `fresh start has one workspace (got ${wsCount})`);
  const profiles = await state(page, "s.profiles.map(p => p.id)");
  log(`detected shells: ${profiles.join(", ")}`);
  assert(profiles.length > 0, "at least one shell detected");

  const first = await focusedSurface(page);
  await waitRunning(page, first);
  log("first terminal is running in ConPTY");

  await typeInTerminal(page, first, 'Write-Output ("wmux-e2e-" + (6*7))');
  await waitFor(async () => (await terminalText(page, first)).includes("wmux-e2e-42"), "real shell output");
  log("real PowerShell command executed (output wmux-e2e-42)");

  // Split right with the keyboard shortcut and run a command in the new pane.
  await page.keyboard.press("Control+Shift+D");
  await waitFor(() => state(page, "s.workspaces[0].panes.length === 2"), "split pane");
  const second = await focusedSurface(page);
  assert(second && second !== first, "new pane has its own terminal");
  await waitRunning(page, second);
  await typeInTerminal(page, second, "Set-Location $env:SystemRoot");
  const winDir = await waitFor(async () => {
    const cwd = await state(page, `s.runtime[${JSON.stringify(second)}]?.cwd`);
    return cwd && /\\windows$/i.test(cwd) ? cwd : null;
  }, "cwd reported via shell integration (OSC 9;9)");
  log(`split pane works; cwd tracked: ${winDir}`);

  // Split down inside the right pane -> nested layout.
  await page.keyboard.press("Control+Shift+E");
  await waitFor(() => state(page, "s.workspaces[0].panes.length === 3"), "nested split");
  const layout = await state(page, "s.workspaces[0].layout");
  assert(layout.type === "split" && layout.direction === "horizontal", "root splits horizontally");
  assert(layout.children[1].type === "split" && layout.children[1].direction === "vertical", "nested vertical split");
  log("nested split layout created");

  // Multiple tabs in one pane.
  await page.keyboard.press("Control+Shift+T");
  await waitFor(() => state(page, "s.workspaces[0].panes.some(p => p.surfaces.length === 2)"), "second tab");
  log("terminal tab created");

  // Second workspace.
  await page.keyboard.press("Control+Shift+N");
  await waitFor(() => state(page, "s.workspaces.length === 2"), "second workspace");
  await page.evaluate(() => {
    const s = window.__wmuxTest.getState();
    s.updateWorkspace(s.activeWorkspaceId, { name: "e2e-backend" });
  });
  await page.keyboard.press("Control+1");
  await waitFor(() => state(page, "s.activeWorkspaceId === s.workspaces[0].id"), "switch workspace with Ctrl+1");
  log("created and switched workspaces");

  await page.screenshot({ path: join(shots, "01-layout.png") });

  // Restart terminal keeps working.
  await page.click(`[data-surface-id="${first}"] .xterm-screen`);
  await page.keyboard.press("Control+Shift+R");
  await waitRunning(page, first);
  await typeInTerminal(page, first, 'Write-Output ("after-" + "restart")');
  await waitFor(async () => (await terminalText(page, first)).includes("after-restart"), "output after restart");
  log("terminal restart works");

  await sleep(1000); // let the debounced autosave run
  log("closing app");
  await closeApp(app);

  // ---------------------------------------------------------------- run 2
  log("relaunching to verify session restore");
  app = await launch();
  page = app.page;

  const names = await state(page, "s.workspaces.map(w => w.name)");
  assert(names.length === 2 && names.includes("e2e-backend"), `workspaces restored (${names})`);
  const restoredLayout = await state(page, "s.workspaces[0].layout");
  assert(JSON.stringify(restoredLayout) === JSON.stringify(layout), "layout restored exactly");
  const restoredCwd = await state(page, `s.workspaces[0].panes.flatMap(p => p.surfaces).find(x => x.id === ${JSON.stringify(second)})?.cwd`);
  assert(restoredCwd && /\\windows$/i.test(restoredCwd), `terminal cwd restored (${restoredCwd})`);
  log("workspaces, layout and working directories restored");

  const restoredFirst = await state(page, "s.workspaces[0].panes[0].surfaces[0].id");
  await waitRunning(page, restoredFirst);
  const text = await terminalText(page, restoredFirst);
  assert(text.includes("Layout restored"), "restored terminal states that it is a new session");
  await typeInTerminal(page, restoredFirst, 'Write-Output ("restored-" + "ok")');
  await waitFor(async () => (await terminalText(page, restoredFirst)).includes("restored-ok"), "restored terminal runs commands");
  log("restored terminals start new real sessions and say so honestly");

  await page.screenshot({ path: join(shots, "02-restored.png") });
  await closeApp(app);
  log("PASS");
}

main()
  .catch(async (e) => {
    console.error(e);
    process.exitCode = 1;
    if (current && current.exitCode === null) current.kill();
  })
  .finally(() => {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
