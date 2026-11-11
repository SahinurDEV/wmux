# Wmux architecture

## Overview

```
┌──────────────────────────── Wmux.exe (Tauri 2) ─────────────────────────────┐
│ WebView2: React + TypeScript                                                 │
│   Zustand store ── layout tree (pure functions, tested)                      │
│   Terminal registry ── xterm.js instances live outside React                 │
│   Command registry ── palette + keyboard shortcuts                           │
│        │ invoke() / Channel (ordered, raw bytes)                             │
│ ───────┼──────────────────────────────────────────────────────────────────── │
│ Rust   ▼                                                                     │
│   commands.rs ── validates input, maps errors to { kind, message }           │
│   wmux-process-manager ── reader / writer / waiter thread per session        │
│   wmux-conpty ── CreatePseudoConsole + Job Object (KILL_ON_JOB_CLOSE)        │
│   wmux-session-manager ── SQLite (WAL, migrations, backup, recovery)         │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Terminal data path

1. `pty_spawn` resolves a shell profile, builds a `CommandSpec` (argv quoted per
   MSVC rules, never a shell string), and spawns it in a pseudo console inside
   a new Job Object (`CREATE_SUSPENDED` → assign to job → resume, so no child
   can escape the job).
2. The **reader** thread forwards output chunks (up to 64 KiB) over a Tauri
   `Channel` as raw bytes with a one-byte tag (`0` = output, `1` = exit). One
   channel keeps output and exit strictly ordered.
3. The **waiter** thread records the exit code, then closes the pseudo
   console; the reader drains the remaining output, reaches EOF and emits the
   exit event. Output always arrives before the exit notice.
4. Input from xterm.js is queued in the frontend and sent one IPC call at a
   time (async commands may otherwise run concurrently and reorder
   keystrokes). The **writer** thread performs the blocking pipe writes.
5. Dropping a session, closing the app or a crash closes the job handle, and
   Windows kills the whole process tree.

### Why terminals live outside React

The registry (`src/terminal/registry.ts`) owns each xterm instance and its PTY
binding. React components only attach or detach the terminal's DOM host. Switching
workspaces, re-rendering split layouts or remounting panel groups therefore
never kills shells or loses scrollback.

### Layout model

A workspace layout is a recursive tree of `split` nodes (direction, children,
percentage sizes) and `leaf` nodes referencing panes. Each pane holds an
ordered list of surfaces (terminal tabs today, browser surfaces later). All tree
operations in `state/layout.ts` are pure and enforce these invariants: splits have
at least two children, sizes sum to 100, and same-direction nesting is flattened.
A randomized test runs 400 split/close operations and checks the invariants after each.
Layouts loaded from disk are sanitized: unknown or duplicate panes are
dropped, and panes missing from the tree are re-attached.

### Persistence

SQLite (`rusqlite`, bundled) in `%APPDATA%\dev.wmux.desktop\wmux.db` (or
`WMUX_DATA_DIR`). Tables: `workspaces`, `panes`, `surfaces`,
`terminal_sessions` (configuration), `terminal_runs` (last PID/exit per
surface, written by the backend), `settings`, `app_state`, `session_history`.

The UI saves a full snapshot 400 ms after changes and on window close. A save
upserts rows and deletes missing ones in one transaction. If the database fails
to open or fails its integrity check, it is moved aside and a fresh one is
created; the UI tells the user where the old file went.

**Restore semantics:** layouts, tabs, titles and working directories are
restored. Processes are not; a restored terminal starts a new shell and prints
which previous process (program and PID) ended.

### Shell integration

With "Shell integration" on, PowerShell is started with
`-NoExit -EncodedCommand <script>`. The script wraps the user's existing
`prompt` function to emit `OSC 9;9;"<cwd>"`. For cmd, `PROMPT` is set only
if the user has not defined one. The frontend also understands `OSC 7`
(bash/zsh/fish/msys). The reported directory drives the status bar, new
splits/tabs ("open here") and restore.

## Windows-specific risks and decisions

| Risk | Decision / mitigation |
| --- | --- |
| `ClosePseudoConsole` can block while output is unread (older Win10) | Never called on the reader thread; the reader keeps draining while another thread closes. |
| Child inherits redirected stdio of the host instead of the PTY | `STARTF_USESTDHANDLES` with `INVALID_HANDLE_VALUE` handles. |
| Orphaned shells/dev servers after a crash | Job Object with `KILL_ON_JOB_CLOSE`; process created suspended and assigned before it runs. |
| Concurrent async IPC reorders keystrokes | Per-terminal serialized input queue in the frontend. |
| WebView2 browser shortcuts (F5, Ctrl+R, Ctrl+P…) | Prevented outside terminals; inside terminals xterm consumes them for the shell. |
| Shortcuts stealing shell keys (Ctrl+D EOF, Ctrl+W, Ctrl+R) | App shortcuts use Ctrl+Shift / Ctrl+Alt; enforced by a unit test. |
| Smart App Control blocks locally compiled binaries | Documented; CI on `windows-latest` builds, tests and packages. Rollup uses its official WASM build (`@rollup/wasm-node`) so frontend tooling runs under SAC. |
| WebView2 in arbitrary split panes (future browser surfaces) | Planned: a native child `ICoreWebView2Controller` per browser surface, positioned from pane bounds reported by the UI. No iframes, no screenshots. |
| Single instance & DB contention | `tauri-plugin-single-instance` focuses the running window. |

## Security model (current)

- The frontend talks only to the explicit command list in `main.rs`.
- Spawn requests are validated (env var names, NUL bytes, existing cwd with
  fallback to home that is reported to the user).
- CSP restricts scripts to the app bundle; links open in the external
  browser only for `http(s)` URLs.
- No secrets are persisted; workspace environment variables are plain text
  and labeled as such in the UI.
