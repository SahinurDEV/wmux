#!/usr/bin/env node
// End-to-end test of moving terminals around in the real app: dragging a tab
// to a pane edge (new split), onto another pane's tab strip, and onto a
// workspace in the sidebar, plus swapping panes with the keyboard.
//
// The point checked throughout: a moved terminal is the same running process
// with its text intact, never a restarted one.
//
// Usage: node tests/e2e/dnd.mjs [path-to-wmux-desktop.exe]
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";

const exe = resolve(process.argv[2] ?? "target/release/wmux-desktop.exe");
const dataDir = mkdtempSync(join(tmpdir(), "wmux-e2e-dnd-"));
const shots = resolve("test-results");
mkdirSync(shots, { recursive: true });
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC_)/i.test(k)));

let step = 0;
const log = (msg) => console.log(`[dnd ${String(++step).padStart(2, "0")}] ${msg}`);
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
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}

let child = null;
let page = null;

async function launch() {
  const port = 9300 + Math.floor(Math.random() * 500);
  child = spawn(exe, [], {
    env: { ...env, WMUX_E2E: "1", WMUX_DATA_DIR: dataDir, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const exited = new Promise((r) => child.on("exit", r));
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok, "WebView2 DevTools endpoint");
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = await waitFor(
    () => browser.contexts().flatMap((c) => c.pages()).find((p) => /tauri\.localhost|localhost:1420/.test(p.url())),
    "app page",
  );
  await page.waitForFunction(() => window.__wmuxTest?.getState().loaded === true, null, { timeout: 30_000 });
  return { browser, exited };
}

const state = (expr) => page.evaluate(`(() => { const s = window.__wmuxTest.getState(); return ${expr}; })()`);
const text = (id) => page.evaluate((s) => window.__wmuxTest.bufferText(s), id);
const focused = () => page.evaluate(() => window.__wmuxTest.focusedSurfaceId());
const pid = (id) => state(`s.runtime[${JSON.stringify(id)}]?.pid`);
const running = (id) => waitFor(() => state(`s.runtime[${JSON.stringify(id)}]?.status === "running"`), `terminal ${id} running`);
/** Tabs of each pane of a workspace, in layout order. */
const layoutOf = (wsIndex) =>
  state(`(() => { const w = s.workspaces[${wsIndex}]; const ids = (n) => n.type === "leaf" ? [n.paneId] : n.children.flatMap(ids);
    return ids(w.layout).map((id) => w.panes.find((p) => p.id === id).surfaces.map((x) => x.id)); })()`);

async function center(selector, fx = 0.5, fy = 0.5) {
  const box = await page.locator(selector).first().boundingBox();
  assert(box, `element ${selector} is on screen`);
  return { x: box.x + box.width * fx, y: box.y + box.height * fy };
}

/** Press on `from`, move in small steps (so the drag threshold is crossed), release on `to`. */
async function drag(from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 12, from.y + 4, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 14 });
  await sleep(150);
  await page.mouse.up();
  await sleep(250);
}

const tab = (id) => `[data-tab-surface-id="${id}"]`;
const paneOf = (id) => state(`s.workspaces.flatMap((w) => w.panes).find((p) => p.surfaces.some((x) => x.id === ${JSON.stringify(id)}))?.id`);

async function main() {
  log(`launching ${exe}`);
  const app = await launch();

  const a = await focused();
  await running(a);
  await page.click(`[data-surface-id="${a}"] .xterm-screen`);
  await page.keyboard.type('Write-Output ("dnd-" + (6*7))', { delay: 5 });
  await page.keyboard.press("Enter");
  await waitFor(async () => (await text(a)).includes("dnd-42"), "marker output");
  const pidA = await pid(a);

  await page.keyboard.press("Control+Shift+T");
  const b = await waitFor(async () => ((await focused()) !== a ? focused() : null), "second tab");
  await running(b);
  const pidB = await pid(b);
  assert(JSON.stringify(await layoutOf(0)) === JSON.stringify([[a, b]]), "one pane with two tabs");
  log("one pane with two tabs, both shells running");

  // Tab -> right edge of its own pane: tears off into a new split.
  const paneA = await paneOf(a);
  await drag(await center(tab(b)), await center(`[data-pane-id="${paneA}"] [data-pane-body]`, 0.92, 0.5));
  await waitFor(async () => JSON.stringify(await layoutOf(0)) === JSON.stringify([[a], [b]]), "tab torn off to the right");
  assert((await pid(b)) === pidB, "torn-off terminal is the same process");
  assert((await state("s.drag")) === null, "drag state cleared");
  log("dragging a tab to a pane edge created a split; its shell kept running");
  await page.screenshot({ path: join(shots, "dnd-split.png") });

  // Tab -> the other pane's tab strip, before its first tab.
  await drag(await center(tab(b)), await center(tab(a), 0.15, 0.5));
  await waitFor(async () => JSON.stringify(await layoutOf(0)) === JSON.stringify([[b, a]]), "tab dropped before another tab");
  assert((await pid(a)) === pidA && (await pid(b)) === pidB, "no terminal restarted");
  log("dragging onto a tab strip merged the panes at the chosen position");

  // A plain click on a tab still just selects it.
  await page.click(tab(a));
  assert((await focused()) === a, "click selects the tab");

  // Escape cancels a drag.
  const from = await center(tab(a));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 200, from.y + 200, { steps: 8 });
  assert((await state("s.drag?.surfaceId")) === a, "drag in progress");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await sleep(200);
  assert(JSON.stringify(await layoutOf(0)) === JSON.stringify([[b, a]]), "Escape cancelled the drag");
  log("Escape cancels a drag");

  // Tab -> another workspace in the sidebar.
  await page.keyboard.press("Control+Shift+N");
  await waitFor(() => state("s.workspaces.length === 2"), "second workspace");
  const ws2 = await state("s.workspaces[1].id");
  const c = await focused();
  await running(c);
  await page.keyboard.press("Control+1");
  await waitFor(() => state("s.activeWorkspaceId === s.workspaces[0].id"), "back on workspace 1");
  await drag(await center(tab(a)), await center(`[data-workspace-id="${ws2}"]`));
  await waitFor(async () => JSON.stringify(await layoutOf(1)) === JSON.stringify([[c], [a]]), "tab moved to workspace 2");
  assert(JSON.stringify(await layoutOf(0)) === JSON.stringify([[b]]), "workspace 1 keeps the other tab");
  assert((await state("s.activeWorkspaceId === s.workspaces[0].id")) === true, "stays on the current workspace");
  assert((await pid(a)) === pidA, "moved terminal is the same process");
  await page.keyboard.press("Control+2");
  await waitFor(async () => (await text(a)).includes("dnd-42"), "moved terminal still shows its text");
  await page.click(`[data-surface-id="${a}"] .xterm-screen`);
  await page.keyboard.type('Write-Output ("still-" + "alive")', { delay: 5 });
  await page.keyboard.press("Enter");
  await waitFor(async () => (await text(a)).includes("still-alive"), "moved terminal accepts input");
  log("dragging a tab onto a workspace moved the live terminal there");
  await page.screenshot({ path: join(shots, "dnd-workspace.png") });

  // Swap panes with the keyboard: focus is on the right pane (a).
  await page.keyboard.press("Control+Alt+Shift+ArrowLeft");
  await waitFor(async () => JSON.stringify(await layoutOf(1)) === JSON.stringify([[a], [c]]), "panes swapped");
  assert((await focused()) === a, "focus follows the swapped pane");
  log("Ctrl+Alt+Shift+Arrow swaps the focused pane with its neighbor");

  await page.click('header button[aria-label="Close"]');
  await Promise.race([app.exited, sleep(15_000).then(() => { throw new Error("app did not exit"); })]);
  await app.browser.close().catch(() => undefined);
  log("PASSED");
}

main()
  .catch(async (e) => {
    console.error(`\n[dnd] FAILED: ${e.message}`);
    process.exitCode = 1;
    await page?.screenshot({ path: join(shots, "dnd-failure.png") }).catch(() => undefined);
    try {
      child?.kill();
    } catch {
      /* already gone */
    }
  })
  .finally(() => {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* files may still be locked briefly */
    }
  });
