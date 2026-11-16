#!/usr/bin/env node
// Takes the product screenshots used on the website (site/assets/) from the
// real app: real shells, real command output, nothing mocked.
//
// The repository is mapped to a drive letter (subst) for the duration of the
// run so prompts and the status bar show a short path instead of a personal
// one. Data goes to a temporary directory; the user's session is not touched.
//
// Usage: node scripts/site-screenshots.mjs [path-to-wmux-desktop.exe]
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { devtoolsEndpoint, devtoolsEnv } from "../tests/e2e/devtools.mjs";

const exe = resolve(process.argv[2] ?? "target/release/wmux-desktop.exe");
const out = resolve("site/assets");
mkdirSync(out, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "wmux-shots-"));
const repo = resolve(".");

// A normal environment: no markers from a parent agent session.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC_)/i.test(k)));

const drive = ["W:", "V:", "U:", "T:"].find((d) => !existsSync(`${d}\\`));
if (!drive) throw new Error("no free drive letter for subst");
execFileSync("subst", [drive, repo]);
const root = `${drive}\\`;

async function waitFor(fn, what, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not ready */
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

let child = null;
let livePage = null;
async function launch() {
  child = spawn(exe, [], {
    env: { ...env, WMUX_E2E: "1", WMUX_DATA_DIR: dataDir, ...devtoolsEnv(dataDir) },
    stdio: "ignore",
  });
  const exited = new Promise((r) => child.on("exit", r));
  const browser = await chromium.connectOverCDP(await devtoolsEndpoint(dataDir, child));
  const page = await waitFor(
    () => browser.contexts().flatMap((c) => c.pages()).find((p) => /tauri\.localhost/.test(p.url())),
    "app page",
  );
  await page.waitForFunction(() => window.__wmuxTest?.getState().loaded === true);
  livePage = page;
  return { page, browser, exited };
}

const text = (page, id) => page.evaluate((s) => window.__wmuxTest.bufferText(s), id);
const focused = (page) => page.evaluate(() => window.__wmuxTest.focusedSurfaceId());
const running = (page, id) =>
  waitFor(() => page.evaluate((s) => window.__wmuxTest.getState().runtime[s]?.status === "running", id), `terminal ${id}`);
const shot = (page, name) => page.screenshot({ path: join(out, `${name}.png`) });

async function type(page, id, line) {
  await page.click(`[data-surface-id="${id}"] .xterm-screen`);
  await page.keyboard.type(line, { delay: 4 });
  await page.keyboard.press("Enter");
}

async function close(app) {
  await app.page.click('header button[aria-label="Close"]');
  await Promise.race([app.exited, sleep(15_000)]);
  await app.browser.close().catch(() => undefined);
}

async function main() {
  let app = await launch();
  let { page } = app;

  // Three workspaces; the first one is the stage.
  await page.evaluate((cwd) => {
    const s = window.__wmuxTest.getState();
    const first = s.workspaces[0].id;
    const main = s.createWorkspace({ name: "wmux", cwd });
    window.__wmuxTest.getState().deleteWorkspace(first);
    const api = window.__wmuxTest.getState().createWorkspace({ name: "api-server", cwd: `${cwd}crates` });
    const docs = window.__wmuxTest.getState().createWorkspace({ name: "docs", cwd: `${cwd}docs` });
    const st = window.__wmuxTest.getState();
    st.updateWorkspace(api, { color: "#5eead4" });
    st.updateWorkspace(docs, { color: "#f472b6" });
    st.togglePin(main);
    st.setActiveWorkspace(main);
  }, root);

  const a = await waitFor(() => focused(page), "first terminal");
  await running(page, a);
  await page.keyboard.press("Control+Shift+D");
  const b = await waitFor(async () => ((await focused(page)) !== a ? focused(page) : null), "right pane");
  await running(page, b);
  await page.keyboard.press("Control+Shift+E");
  const c = await waitFor(async () => (![a, b].includes(await focused(page)) ? focused(page) : null), "bottom pane");
  await running(page, c);
  await sleep(2500);

  await type(page, a, "git log --oneline -n 6");
  await waitFor(async () => /[0-9a-f]{7} /.test(await text(page, a)), "git log");
  await type(page, a, "cargo test -p wmux-session-manager --lib");
  await type(page, b, "git --no-pager show --stat --format='%h %s' HEAD");
  await type(page, c, "node apps/desktop/node_modules/vite/bin/vite.js apps/desktop");
  await waitFor(async () => (await text(page, a)).includes("test result: ok"), "cargo test", 180_000);
  await waitFor(async () => /files? changed/.test(await text(page, b)), "git show", 60_000);
  await waitFor(async () => /localhost:1420/.test(await text(page, c)), "vite dev server", 120_000);
  await sleep(1500);
  await page.click(`[data-surface-id="${a}"] .xterm-screen`);
  await sleep(400);
  await shot(page, "workspace");

  // Command palette.
  await page.keyboard.press("Control+Shift+P");
  await sleep(400);
  await page.keyboard.type("split", { delay: 30 });
  await sleep(500);
  await shot(page, "palette");
  await page.keyboard.press("Escape");

  // Settings: the restore options live on the Terminal tab.
  await page.evaluate(() => window.__wmuxTest.getState().setOverlay({ kind: "settings", tab: "terminal" }));
  await sleep(600);
  await shot(page, "settings");
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__wmuxTest.getState().setOverlay(null));

  // Light theme.
  await page.evaluate(() => window.__wmuxTest.runCommand("view.themeToggle"));
  await sleep(900);
  await shot(page, "workspace-light");
  await page.evaluate(() => window.__wmuxTest.runCommand("view.themeToggle"));
  await sleep(600);

  // Restart: text comes back, the dev server is started again.
  await sleep(11_000); // one periodic save
  await close(app);
  app = await launch();
  page = app.page;
  for (const id of [a, b, c]) await running(page, id);
  await waitFor(async () => {
    const t = await text(page, c);
    return /localhost:1420/.test(t.slice(t.lastIndexOf("session restored")));
  }, "dev server after restart", 120_000);
  await sleep(1500);
  // Idle restored panes reveal their history by themselves shortly after start.
  await sleep(2000);
  await sleep(500);
  await shot(page, "restored");

  // Stop the dev server before closing so nothing is left running.
  await page.click(`[data-surface-id="${c}"] .xterm-screen`);
  await page.keyboard.press("Control+C");
  await sleep(1500);
  await close(app);
  console.log(`screenshots written to ${out}`);
}

main()
  .catch(async (e) => {
    console.error(`FAILED: ${e.message}`);
    process.exitCode = 1;
    mkdirSync(resolve("test-results"), { recursive: true });
    await livePage?.screenshot({ path: resolve("test-results/site-screenshots-failure.png") }).catch(() => undefined);
    try {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  })
  .finally(async () => {
    await sleep(500);
    try {
      execFileSync("subst", [drive, "/D"]);
    } catch {
      /* mapping already removed */
    }
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* briefly locked */
    }
  });
