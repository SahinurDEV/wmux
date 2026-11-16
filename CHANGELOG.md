# Changelog

## 0.4.0 (2026-11-16): Updates from inside the app

- **Wmux updates itself.** It looks for a new version on GitHub when it starts
  and a few times a day. When there is one, an **Update to vX** button appears
  in the status bar; clicking it downloads the new version, installs it and
  restarts Wmux with your terminals restored. Nothing is installed without
  that click.
- Every update is checked against a signing key built into the app before it
  runs.
- Works for copies installed with the setup program (`*-setup.exe`). MSI and
  portable copies are told about the new version and sent to the download
  page.
- **Check for Updates** in the command palette, and a switch for the automatic
  check under Settings → General.
- This is the first version that can update itself, so moving from 0.3.0 or
  older to it is still a manual install.
- Dependencies: lucide-react 1.70, winreg 0.56, base64 0.23.

## 0.3.0 (2026-11-16): Drag and drop, agent status

- **Drag tabs.** Drag a terminal tab onto another pane's tab strip to move it
  there, onto a side of a pane to split it off, or onto a workspace in the
  sidebar to send it to that workspace. The terminal keeps running.
- **Agents are shown.** Wmux recognizes Claude Code, Codex, Gemini CLI,
  OpenCode and Aider running in a terminal and marks the tab, the workspace in
  the sidebar and the status bar with what the agent is doing: working,
  waiting for you, or idle. Claude Code's own status is used; for the others,
  recent terminal output counts as working.
- **Move a pane to another workspace** from the pane menu.
- **Swap panes** with `Ctrl+Alt+Shift+Arrow`.

## 0.2.0 (2026-11-16): Session restore across restarts

Closing Wmux, or shutting down the PC, no longer loses what was in a terminal.

- **Terminal text is restored.** Each terminal's screen and scrollback are saved
  every few seconds and on close, and shown again above the new prompt.
- **Agent sessions resume.** Wmux notices Claude Code and Codex running in a
  terminal and remembers the agent's own session id; after a restart it runs
  `claude --resume <id>` / `codex resume <id>` in that terminal, in the
  directory the agent was started in. Nothing is installed into the agents.
- **Running commands start again.** With PowerShell shell integration, the
  command that was still running when Wmux closed is re-run. A command that had
  already finished is not.
- An idle restored terminal opens scrolled so its earlier text fills the pane,
  with the new prompt below it.
- Tabs show the shell's name (`pwsh`) instead of the full path of its exe.
- New settings under Terminal: *Restore terminal text*, *Resume agent
  sessions*, *Re-run running commands* (all on by default).
- `pnpm dev` now runs under its own app identity, so a development build no
  longer collides with an installed Wmux or touches its data.
- A website with a getting-started guide lives in `site/`.

Limits: re-running commands needs PowerShell (cmd, Git Bash and WSL restore
text only); agents running inside WSL are not detected; multi-line commands are
not re-run; with several Codex sessions open at once the match of session to
terminal is best effort.

## 0.1.0 (2026-11-11): Milestone 1, early preview

- ConPTY terminal engine with Job Object process-tree management.
- Shell detection: PowerShell 7, Windows PowerShell, cmd, WSL, Git Bash, custom profiles.
- Workspaces: create, rename, duplicate, pin, color, reorder; per-workspace
  directory, shell, startup commands and environment variables.
- Recursive split panes with tabs, resizing, maximize and directional focus.
- SQLite persistence with migrations, corruption recovery and backups; restore
  of workspaces, layouts, tabs and working directories.
- Command palette, configurable shortcuts, terminal search, light/dark themes.
