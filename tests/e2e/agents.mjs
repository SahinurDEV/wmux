#!/usr/bin/env node
// End-to-end test of agent detection in the real app, without needing an
// agent account: a harmless program (a copy of node.exe running a one-line
// script) is run under the file name of an agent CLI. Wmux should notice it in the terminal's
// process tree, show it on the tab, the sidebar and the status bar, report it
// as working while it prints and idle when it goes quiet, and drop it when it
// exits.
//
// Usage: node tests/e2e/agents.mjs [path-to-wmux-desktop.exe]
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";

const exe = resolve(process.argv[2] ?? "target/release/wmux-desktop.exe");
const dataDir = mkdtempSync(join(tmpdir(), "wmux-e2e-agents-"));
const fakeDir = mkdtempSync(join(tmpdir(), "wmux-e2e-fake-agent-"));
const fakeAgent = join(fakeDir, "aider.exe");
copyFileSync(process.execPath, fakeAgent);
/** A shell command that runs `script` in the stand-in agent. */
const fake = (script) => `& '${fakeAgent}' -e '${script}'`;
const shots = resolve("test-results");
mkdirSync(shots, { recursive: true });
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC_)/i.test(k)));

let step = 0;
const log = (msg) => console.log(`[agents ${String(++step).padStart(2, "0")}] ${msg}`);
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
  page = await waitFor(
    () => browser.contexts().flatMap((c) => c.pages()).find((p) => /tauri\.localhost|localhost:1420/.test(p.url())),
    "app page",
  );
  await page.waitForFunction(() => window.__wmuxTest?.getState().loaded === true, null, { timeout: 30_000 });
  return { browser, exited };
}

const state = (expr) => page.evaluate(`(() => { const s = window.__wmuxTest.getState(); return ${expr}; })()`);
const focused = () => page.evaluate(() => window.__wmuxTest.focusedSurfaceId());
const attr = (selector, name) => page.locator(selector).first().getAttribute(name);

async function run(id, line) {
  await page.click(`[data-surface-id="${id}"] .xterm-screen`);
  await page.keyboard.type(line, { delay: 4 });
  await page.keyboard.press("Enter");
}

async function main() {
  log(`launching ${exe}`);
  const app = await launch();
  const a = await focused();
  await waitFor(() => state(`s.runtime[${JSON.stringify(a)}]?.status === "running"`), "terminal running");
  const tab = `[data-tab-surface-id="${a}"]`;
  assert((await attr(tab, "data-agent")) === null, "a plain shell is not an agent");
  assert((await state("Object.keys(s.agents).length")) === 0, "no agents at start");

  // A program named like the Aider CLI that prints twice a second for 12 s.
  await run(a, fake("setInterval(()=>console.log(Date.now()),500);setTimeout(()=>process.exit(0),12000)"));
  const agent = await waitFor(() => state(`s.agents[${JSON.stringify(a)}]`), "agent to be detected", 20_000);
  assert(agent.kind === "aider", `detected as aider (got ${JSON.stringify(agent)})`);
  assert(agent.pid > 0 && agent.sessionId === null, "no session id for an agent that has none");
  log(`detected ${agent.kind} (pid ${agent.pid}) below the shell`);

  await waitFor(async () => (await attr(tab, "data-agent")) === "aider", "tab shows the agent");
  await waitFor(async () => (await attr(tab, "data-agent-activity")) === "working", "working while it prints");
  const ws = await state("s.workspaces[0].id");
  await waitFor(
    async () => (await attr(`[data-workspace-id="${ws}"] [data-workspace-agents]`, "data-workspace-agents")) === "working",
    "sidebar shows a working agent",
  );
  const bar = await page.locator("footer").innerText();
  assert(/Aider/.test(bar) && /working/.test(bar), `status bar names the agent (${bar.replace(/\s+/g, " ")})`);
  log("tab, sidebar and status bar show the agent as working");
  await page.screenshot({ path: join(shots, "agents-working.png") });

  // When it exits, the indicators go away.
  await waitFor(() => state(`!s.agents[${JSON.stringify(a)}]`), "agent to disappear after it exits", 40_000);
  await waitFor(async () => (await attr(tab, "data-agent")) === null, "tab back to a plain terminal");
  assert((await page.locator("[data-workspace-agents]").count()) === 0, "sidebar indicator removed");
  log("indicators removed when the agent exited");

  // An agent that goes quiet is idle: this one waits silently for 25 s.
  await run(a, fake("setTimeout(()=>{},25000)"));
  await waitFor(async () => (await attr(tab, "data-agent")) === "aider", "agent detected again", 20_000);
  await waitFor(async () => (await attr(tab, "data-agent-activity")) === "idle", "idle once output stops", 20_000);
  log("an agent with no recent output is shown as idle");
  await page.click(`[data-surface-id="${a}"] .xterm-screen`);
  await page.keyboard.press("Control+C");
  await waitFor(() => state(`!s.agents[${JSON.stringify(a)}]`), "agent gone after Ctrl+C", 20_000);

  await page.click('header button[aria-label="Close"]');
  await Promise.race([app.exited, sleep(15_000).then(() => { throw new Error("app did not exit"); })]);
  await app.browser.close().catch(() => undefined);
  log("PASSED");
}

main()
  .catch(async (e) => {
    console.error(`\n[agents] FAILED: ${e.message}`);
    process.exitCode = 1;
    await page?.screenshot({ path: join(shots, "agents-failure.png") }).catch(() => undefined);
    try {
      child?.kill();
    } catch {
      /* already gone */
    }
  })
  .finally(async () => {
    await sleep(500);
    for (const dir of [dataDir, fakeDir]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* files may still be locked briefly */
      }
    }
  });
