# Progress

Legend: ✅ done and covered by tests · 🟡 implemented, awaiting first CI/E2E run · ⬜ not started

> All Rust code is verified only by CI (`.github/workflows/ci.yml`) because Smart
> App Control on the primary development machine blocks locally compiled
> binaries. Frontend code is type-checked and unit-tested locally.

## Milestone 1: foundation, terminals, workspaces, splits, persistence

| Item | Status | Verification |
| --- | --- | --- |
| Monorepo (pnpm + Cargo workspace) | ✅ | `pnpm install`, frontend build |
| Tauri 2 app, custom title bar, window controls, window-state restore | 🟡 | CI build + E2E |
| Dark/light/system theme, accent colors | ✅ | UI preview screenshots |
| Sidebar: create/switch/rename/duplicate/pin/color/reorder/delete workspaces | ✅ | `store.test.ts`, UI preview |
| Per-workspace cwd, shell, startup commands, env vars | 🟡 | unit tests (model); E2E pending |
| ConPTY engine (`wmux-conpty`): spawn, I/O, resize, exit codes, kill tree | 🟡 | `crates/conpty/tests` (8 integration tests) in CI |
| Process manager: threads, ordering, restart, graceful close | 🟡 | `crates/process-manager/tests` in CI |
| Shell detection: pwsh, Windows PowerShell, cmd, WSL, Git Bash, custom | 🟡 | unit tests in CI |
| xterm.js terminals (WebGL, Unicode 11, links, search, copy/paste) | 🟡 | E2E |
| Multiple tabs per pane | ✅ | `store.test.ts`; E2E |
| Recursive horizontal/vertical splits, resize, maximize, directional focus | ✅ | `layout.test.ts` (incl. randomized), E2E |
| SQLite persistence, migrations, backup, corruption recovery | 🟡 | `crates/session-manager` tests in CI |
| Restart & restore workspaces, layout, cwd | 🟡 | E2E (two launches) |
| Command palette + configurable shortcuts | ✅ | `commands.test.ts`, `fuzzy.test.ts` |
| Installers (NSIS, MSI) + portable ZIP | 🟡 | CI artifacts |

## Later phases

| Phase | Items | Status |
| --- | --- | --- |
| 3 | Drag & drop panes/tabs, move pane between workspaces, swap via UI | ⬜ (tree ops `swapPanes` exist and are tested) |
| 4 | Agent adapters (Claude Code, Codex, Gemini CLI, OpenCode, Aider), status detection | ⬜ |
| 5 | WebView2 browser surfaces (native child controller), automation API | ⬜ |
| 6 | Git panel, port monitoring, workspace search | ⬜ |
| 7 | `wmux.exe` CLI, named-pipe JSON-RPC, event subscriptions | ⬜ |
| 8 | Agent session recovery, browser restoration, crash recovery UI | ⬜ |
| 9 | Notifications (OSC 9/777, rings, badges, toasts), tray, a11y pass | ⬜ |
| 10 | Code signing, auto-update, ARM64 | ⬜ |
