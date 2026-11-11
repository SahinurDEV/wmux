// Parsers for shell → terminal working-directory reports.
//
//  * OSC 9;9;"<path>"   Windows Terminal convention (PowerShell/cmd integration)
//  * OSC 7;file://host/<path>   freedesktop convention (bash, zsh, fish, msys)

/** Convert an msys/Git Bash style path (/c/Users/x) to a Windows path. */
function msysToWindows(p: string): string | null {
  const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
  if (!m) return null;
  return `${m[1]!.toUpperCase()}:${(m[2] ?? "/").replace(/\//g, "\\")}`;
}

function normalizeWindowsPath(p: string): string | null {
  const t = p.trim();
  if (/^[a-zA-Z]:[\\/]/.test(t) || /^\\\\[^\\]+\\[^\\]+/.test(t)) return t.replace(/\//g, "\\");
  return null;
}

/** OSC 9 payload (handler receives everything after "9;"). Returns a Windows path or null. */
export function parseOsc9(data: string): string | null {
  if (!data.startsWith("9;")) return null;
  let p = data.slice(2).trim();
  if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) p = p.slice(1, -1);
  return normalizeWindowsPath(p) ?? msysToWindows(p);
}

/**
 * OSC 7 payload: `file://host/path`. Returns the Windows path when the report
 * refers to the local Windows filesystem; Linux paths from WSL return null
 * (they cannot be used as a Windows working directory).
 */
export function parseOsc7(data: string): string | null {
  let url: URL;
  try {
    url = new URL(data);
  } catch {
    return null;
  }
  if (url.protocol !== "file:") return null;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  // file:///C:/Users/x -> "/C:/Users/x"
  const drive = /^\/([a-zA-Z]:)(\/.*)?$/.exec(path);
  if (drive) return `${drive[1]!.toUpperCase()}${(drive[2] ?? "/").replace(/\//g, "\\")}`;
  return msysToWindows(path);
}
