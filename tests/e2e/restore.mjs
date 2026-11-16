#!/usr/bin/env node
// End-to-end test of session restore against the real, built Wmux app.
//
// Drives the app through several restarts and checks that a terminal comes
// back with its text, that the command that was still running starts again,
// that a command which had finished does not, and (with --agent) that a
// Claude Code session is detected and resumed with its own session id.
//
// A hard kill of the app stands in for the PC shutting down.
// Data goes to a temporary directory (WMUX_DATA_DIR); the user's real
// session is never touched.
//
// Usage: node tests/e2e/restore.mjs [path-to-wmux-desktop.exe] [--agent]
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const withAgent = args.includes("--agent");
const exe = resolve(args.find((a) => !a.startsWith("--")) ?? "target/release/wmux-desktop.exe");
const dataDir = mkdtempSync(join(tmpdir(), "wmux-e2e-restore-"));
const shots = resolve("test-results");
mkdirSync(shots, { recursive: true });

let step = 0;
const log = (msg) => console.log(`[restore ${String(++step).padStart(2, "0")}] ${msg}`);

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

// When this test is itself started from inside Claude Code, the agent launched
// in the test terminal would inherit its markers and run as a nested child
// session (no transcript, nothing to resume). Give the app a normal environment.
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => k === "CLAUDE_CONFIG_DIR" || !/^(CLAUDE|ANTHROPIC_)/i.test(k)),
);

let current = null;
/** Page of the running app, kept for diagnostics when a step fails. */
let currentPage = null;

async function launch() {
  const port = 9300 + Math.floor(Math.random() * 500);
  const child = spawn(exe, [], {
    env: {
      ...cleanEnv,
      WMUX_E2E: "1",
      WMUX_DATA_DIR: dataDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const exited = new Promise((r) => child.on("exit", r));
  current = child;
  // The endpoint may listen on IPv4 or IPv6 loopback depending on the WebView2 runtime.
  const endpoint = await waitFor(
    async () => {
      for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
        const url = `http://${host}:${port}`;
        if (await fetch(`${url}/json/version`).then((r) => r.ok, () => false)) return url;
      }
      return null;
    },
    "WebView2 DevTools endpoint",
    90_000,
  );
  const browser = await chromium.connectOverCDP(endpoint);
  const page = await waitFor(
    () => browser.contexts().flatMap((c) => c.pages()).find((p) => /tauri\.localhost|localhost:1420/.test(p.url())),
    "app page",
  );
  await page.waitForFunction(() => window.__wmuxTest?.getState().loaded === true, null, { timeout: 30_000 });
  currentPage = page;
  return { child, browser, page, exited };
}

const state = (page, expr) => page.evaluate(`(() => { const s = window.__wmuxTest.getState(); return ${expr}; })()`);
const terminalText = (page, id) => page.evaluate((sid) => window.__wmuxTest.bufferText(sid), id);
const focusedSurface = (page) => page.evaluate(() => window.__wmuxTest.focusedSurfaceId());
/** What the app has saved for a terminal (scrollback, agent, running command). */
const saved = (page, id) => page.evaluate((sid) => window.__TAURI_INTERNALS__.invoke("terminal_restore_get", { id: sid }), id);

const MARKER = "session restored";
/** Terminal text printed after the most recent restore (i.e. by this run). */
async function textSinceRestore(page, id) {
  const text = await terminalText(page, id);
  const at = text.lastIndexOf(MARKER);
  return at < 0 ? null : text.slice(at);
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

/** Kill the app and everything in its terminals at once, like a PC shutdown. */
async function hardKill(app) {
  execFileSync("taskkill", ["/F", "/T", "/PID", String(app.child.pid)], { stdio: "ignore" });
  await Promise.race([app.exited, sleep(15_000).then(() => { throw new Error("app did not die"); })]);
  await app.browser.close().catch(() => undefined);
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
/** Newest `tick-<unix seconds>` printed in `text`, or 0. */
const newestTick = (text) => Math.max(0, ...[...text.matchAll(/tick-(\d{10})/g)].map((m) => Number(m[1])));

const LOOP = 'while ($true) { Write-Output ("tick-" + [DateTimeOffset]::Now.ToUnixTimeSeconds()); Start-Sleep -Milliseconds 500 }';

async function main() {
  // ------------------------------------------------- run 1: create state
  log(`launching ${exe}`);
  let app = await launch();
  let { page } = app;
  const surface = await focusedSurface(page);
  await waitRunning(page, surface);

  await typeInTerminal(page, surface, 'Write-Output ("restore-marker-" + (6*7))');
  await waitFor(async () => (await terminalText(page, surface)).includes("restore-marker-42"), "marker output");
  await typeInTerminal(page, surface, LOOP);
  await waitFor(async () => newestTick(await terminalText(page, surface)) > 0, "long-running command output");
  log("ran a command and started a long-running one");

  const reported = await waitFor(
    async () => {
      const cmd = (await saved(page, surface)).runningCommand;
      return cmd?.includes("tick-") ? cmd : null;
    },
    "shell to report the running command",
    20_000,
  );
  log(`shell integration reported the running command: ${reported.slice(0, 50)}...`);

  await closeApp(app);
  log("closed the app normally");

  // --------------------------- run 2: restored after a normal close
  let relaunched = nowSeconds();
  app = await launch();
  page = app.page;
  assert((await focusedSurface(page)) === surface, "same terminal after restart");
  await waitRunning(page, surface);
  let text = await waitFor(() => textSinceRestore(page, surface), "restore marker");
  const all = await terminalText(page, surface);
  assert(all.includes("restore-marker-42"), "previous terminal text is back");
  assert(all.indexOf("restore-marker-42") < all.lastIndexOf(MARKER), "old text sits above the restore marker");
  log("previous terminal text restored");
  await waitFor(async () => (await textSinceRestore(page, surface)).includes("Re-running"), "re-run notice");
  await waitFor(async () => newestTick(await textSinceRestore(page, surface)) >= relaunched, "re-run command producing new output", 60_000);
  log("the command that was running started again and is producing output");
  await page.screenshot({ path: join(shots, "restore-after-close.png") });

  // ------------------- run 3: restored after a hard kill ("shutdown")
  log("waiting for the periodic save, then killing the app without warning");
  await waitFor(async () => /tick-\d{10}/.test((await saved(page, surface)).scrollback ?? "") && (await saved(page, surface)).runningCommand, "periodic save", 30_000);
  await sleep(11_000); // one more full save interval so recent output is included
  const before = newestTick((await saved(page, surface)).scrollback ?? "");
  await hardKill(app);
  relaunched = nowSeconds();
  app = await launch();
  page = app.page;
  await waitRunning(page, surface);
  await waitFor(() => textSinceRestore(page, surface), "restore marker after kill");
  text = await terminalText(page, surface);
  assert(text.includes("restore-marker-42"), "text from two runs ago survived the kill");
  assert(newestTick(text.slice(0, text.lastIndexOf(MARKER))) >= before, "output saved shortly before the kill is back");
  await waitFor(async () => newestTick(await textSinceRestore(page, surface)) >= relaunched, "re-run after hard kill", 60_000);
  log("after a hard kill: text restored and the command is running again");
  await page.screenshot({ path: join(shots, "restore-after-kill.png") });

  // ---------------- run 4: a command that finished is not run again
  await page.click(`[data-surface-id="${surface}"] .xterm-screen`);
  await page.keyboard.press("Control+C");
  await waitFor(async () => (await saved(page, surface)).runningCommand === null, "stopped command to be forgotten", 20_000);
  log("stopped the command with Ctrl+C; it is no longer remembered");
  await closeApp(app);
  app = await launch();
  page = app.page;
  await waitRunning(page, surface);
  await waitFor(() => textSinceRestore(page, surface), "restore marker");
  await sleep(6_000);
  text = await textSinceRestore(page, surface);
  assert(!text.includes("Re-running"), "a finished command is not re-run");
  assert(newestTick(text) === 0, "no new loop output");
  log("a command that had finished was not run again");

  // -------------------------- run 5 (optional): agent session resume
  if (withAgent) {
    await typeInTerminal(page, surface, "claude");
    const agent = await waitFor(async () => (await saved(page, surface)).agent, "Claude Code session to be detected", 90_000);
    assert(agent.kind === "claude" && /^[0-9a-f-]{36}$/.test(agent.sessionId), `claude session recorded (${JSON.stringify(agent)})`);
    log(`detected Claude Code session ${agent.sessionId} in ${agent.cwd}`);
    await page.screenshot({ path: join(shots, "restore-agent-running.png") });
    await sleep(11_000);
    await hardKill(app);
    app = await launch();
    page = app.page;
    await waitRunning(page, surface);
    const expected = `claude --resume ${agent.sessionId}`;
    await waitFor(async () => ((await textSinceRestore(page, surface)) ?? "").replace(/\n/g, "").includes(expected), "agent resume command", 30_000);
    log(`after restart the terminal ran: ${expected}`);
    await sleep(15_000);
    await page.screenshot({ path: join(shots, "restore-agent-resumed.png") });
    const again = await saved(page, surface);
    log(`agent seen after resume: ${JSON.stringify(again.agent)}`);
  }

  await closeApp(app);
  log("PASSED");
}

main()
  .catch(async (e) => {
    console.error(`\n[restore] FAILED: ${e.message}`);
    process.exitCode = 1;
    try {
      const id = await focusedSurface(currentPage);
      const text = (await terminalText(currentPage, id)).replace(/\s+$/, "").split("\n").slice(-25).join("\n");
      const { scrollback, ...rest } = await saved(currentPage, id);
      console.error(`--- terminal (last lines) ---\n${text}\n--- saved ---\n${JSON.stringify({ ...rest, scrollbackChars: scrollback?.length ?? 0 })}`);
      await currentPage.screenshot({ path: join(shots, "restore-failure.png") });
    } catch {
      /* the app is gone; nothing to show */
    }
    try {
      current?.kill();
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
