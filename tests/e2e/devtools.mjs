// Shared by the end-to-end tests: start the app's WebView2 with remote
// debugging on and find the DevTools endpoint to connect to.
//
// With WMUX_E2E set, the app starts its browser with
// `--remote-debugging-port=0`: the browser picks a free port and writes it to
// a `DevToolsActivePort` file in its profile folder, which is read here. (The
// app passes the flag itself because WebView2 ignores the
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS variable on GitHub's runners.)
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const profileDir = (dataDir) => join(dataDir, "webview");

/** Every `DevToolsActivePort` file below `dir` (WebView2 keeps it in `EBWebView`). */
function portFiles(dir, depth = 2) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name === "DevToolsActivePort") found.push(path);
    else if (entry.isDirectory() && depth > 0) found.push(...portFiles(path, depth - 1));
  }
  return found;
}

/**
 * Environment variables that give the app a private browser profile under
 * `dataDir`. Call once per launch, together with WMUX_E2E.
 */
export function devtoolsEnv(dataDir) {
  // A file left by the previous launch would point at a dead port.
  for (const file of portFiles(profileDir(dataDir))) rmSync(file, { force: true });
  return {
    WEBVIEW2_USER_DATA_FOLDER: profileDir(dataDir),
  };
}

function diagnostics(dataDir) {
  const ps = (script) => {
    try {
      return execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", timeout: 30_000 }).trim();
    } catch (e) {
      return `(failed: ${e.message.split("\n")[0]})`;
    }
  };
  return [
    `profile folder: ${profileDir(dataDir)} (${existsSync(profileDir(dataDir)) ? "exists" : "missing"})`,
    `port files: ${JSON.stringify(portFiles(profileDir(dataDir)))}`,
    "browser processes:",
    ps(
      "Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' } | ForEach-Object { \"  pid $($_.ProcessId): $($_.CommandLine)\" }",
    ),
    "listening ports of browser processes:",
    ps(
      "$ids = (Get-Process msedgewebview2 -ErrorAction SilentlyContinue).Id; Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess } | ForEach-Object { \"  $($_.LocalAddress):$($_.LocalPort) (pid $($_.OwningProcess))\" }",
    ),
  ].join("\n");
}

/**
 * Wait for the DevTools endpoint of the app started with `devtoolsEnv` and
 * return its URL. `child` is the app process; if it exits first, this fails
 * at once instead of waiting out the timeout.
 */
export async function devtoolsEndpoint(dataDir, child, timeoutMs = 90_000) {
  const start = Date.now();
  let last = "no DevToolsActivePort file yet";
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`the app exited (code ${child.exitCode}) before its DevTools endpoint came up`);
    for (const file of portFiles(profileDir(dataDir))) {
      const port = Number(readFileSync(file, "utf8").split("\n")[0]);
      if (!Number.isInteger(port) || port <= 0) continue;
      // The endpoint may listen on IPv4 or IPv6 loopback depending on the runtime.
      for (const host of ["127.0.0.1", "[::1]"]) {
        const url = `http://${host}:${port}`;
        try {
          if ((await fetch(`${url}/json/version`)).ok) return url;
          last = `${url} answered with an error`;
        } catch (e) {
          last = `${url}: ${e.cause?.code ?? e.message}`;
        }
      }
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for WebView2 DevTools endpoint (last: ${last})\n${diagnostics(dataDir)}`);
}
