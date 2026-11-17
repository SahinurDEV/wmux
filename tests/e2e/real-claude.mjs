#!/usr/bin/env node
// Manual check with the real Claude Code CLI (needs it installed and signed
// in, so it is not part of CI): start `claude` in a Wmux terminal, send one
// short message, close Wmux, open it again and expect the same Claude session
// to be resumed in the same terminal.
//
// Usage (from PowerShell): node tests/e2e/real-claude.mjs [path-to-wmux-desktop.exe]
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { devtoolsEndpoint, devtoolsEnv } from "./devtools.mjs";

const exe = resolve(process.argv[2] ?? "target/release/wmux-desktop.exe");
const dataDir = mkdtempSync(join(tmpdir(), "wmux-e2e-claude-"));
const shots = resolve("test-results");
mkdirSync(shots, { recursive: true });
// Wmux must not look like it runs inside another Claude session.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC_)/i.test(k)));

let step = 0;
const log = (msg) => console.log(`[claude ${String(++step).padStart(2, "0")}] ${msg}`);

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
    await sleep(300);
  }
  throw new Error(`Timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}

let child = null;
let page = null;

async function launch() {
  child = spawn(exe, [], {
    env: { ...env, WMUX_E2E: "1", WMUX_DATA_DIR: dataDir, ...devtoolsEnv(dataDir) },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const exited = new Promise((r) => child.on("exit", r));
  const endpoint = await devtoolsEndpoint(dataDir, child);
  const browser = await chromium.connectOverCDP(endpoint);
  page = await waitFor(
    () => browser.contexts().flatMap((c) => c.pages()).find((p) => /tauri\.localhost|localhost:1420/.test(p.url())),
    "app page",
  );
  await page.waitForFunction(() => window.__wmuxTest?.getState().loaded === true, null, { timeout: 30_000 });
  return { browser, exited };
}
const state = (expr) => page.evaluate(`(() => { const s = window.__wmuxTest.getState(); return ${expr}; })()`);
const focused = () => page.evaluate(() => window.__wmuxTest.focusedSurfaceId());
async function close(app) {
  await page.click('header button[aria-label="Close"]');
  await Promise.race([app.exited, sleep(20_000).then(() => { throw new Error("app did not exit"); })]);
  await app.browser.close().catch(() => undefined);
}

async function main() {
  log(`launching ${exe}`);
  let app = await launch();
  const a = await focused();
  const key = JSON.stringify(a);
  await waitFor(() => state(`s.runtime[${key}]?.status === "running"`), "terminal running");
  await page.click(`[data-surface-id="${a}"] .xterm-screen`);
  // The folder this is run from, which Claude must already trust; in a folder
  // it has not seen it stops to ask first.
  await page.keyboard.type(`cd '${process.cwd()}'`, { delay: 4 });
  await page.keyboard.press("Enter");
  await sleep(2500);
  await page.click(`[data-surface-id="${a}"] .xterm-screen`);
  await page.keyboard.type("claude", { delay: 30 });
  await page.keyboard.press("Enter");
  await waitFor(() => state(`s.agents[${key}]?.kind === "claude"`), "claude to be detected", 60_000);
  await sleep(6000);
  await page.screenshot({ path: join(shots, "claude-1-started.png") });
  await page.keyboard.type("Reply with the single word: ready", { delay: 10 });
  await page.keyboard.press("Enter");
  const first = await waitFor(() => state(`s.agents[${key}]?.sessionId ? s.agents[${key}] : null`), "a Claude session id", 60_000);
  log(`running session ${first.sessionId}`);
  await sleep(15_000);
  await page.screenshot({ path: join(shots, "claude-2-answered.png") });
  const before = await state(`s.agents[${key}]`);
  log(`before closing: ${JSON.stringify(before)}`);
  await close(app);
  log("closed Wmux");

  await sleep(2000);
  app = await launch();
  const again = await waitFor(() => state(`s.agents[${key}]?.sessionId ? s.agents[${key}] : null`), "Claude to be resumed", 90_000);
  await sleep(8000);
  await page.screenshot({ path: join(shots, "claude-3-resumed.png") });
  log(`after reopening: ${JSON.stringify(again)}`);
  if (again.sessionId !== before.sessionId) throw new Error(`resumed ${again.sessionId}, expected ${before.sessionId}`);
  // Leave Claude cleanly so nothing keeps running.
  await page.click(`[data-surface-id="${a}"] .xterm-screen`);
  await page.keyboard.type("/exit", { delay: 10 });
  await page.keyboard.press("Enter");
  await sleep(3000);
  await close(app);
  log("PASSED: the same Claude session came back");
}

main()
  .catch(async (e) => {
    console.error(`\n[claude] FAILED: ${e.message}`);
    process.exitCode = 1;
    await page?.screenshot({ path: join(shots, "claude-failure.png") }).catch(() => undefined);
    try {
      child?.kill();
    } catch {
      /* already gone */
    }
  })
  .finally(async () => {
    await sleep(500);
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* files may still be locked briefly */
    }
  });
