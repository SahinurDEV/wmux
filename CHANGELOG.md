# Changelog

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
- New settings under Terminal: *Restore terminal text*, *Resume agent
  sessions*, *Re-run running commands* (all on by default).
- `pnpm dev` now runs under its own app identity, so a development build no
  longer collides with an installed Wmux or touches its data.

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
