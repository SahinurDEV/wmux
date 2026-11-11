# Contributing to Wmux

Thanks for helping! Wmux is a Windows-first desktop app, so most work needs a
Windows 10/11 machine (see the Smart App Control note in the README).

## Ground rules

1. **No fake features.** Never ship mock terminal output, simulated processes,
   placeholder buttons or fake browser automation. If something is not
   implemented, it does not appear in the UI.
2. **Never block the UI thread.** Tauri commands are `async`; long-running work
   lives on dedicated threads (see `crates/process-manager`).
3. **Surface errors, don't swallow them.** Show a toast or write the error into
   the terminal, and log it on the backend.
4. **Shell input belongs to the shell.** Default shortcuts must not use plain
   `Ctrl+<letter>`; a unit test enforces this.
5. **Don't break existing behavior.** Add tests with every change.

## Workflow

```powershell
pnpm install
pnpm dev                              # app with hot reload
pnpm --filter @wmux/desktop test      # Vitest unit tests
pnpm --filter @wmux/desktop typecheck
cargo test --workspace                # Rust unit + ConPTY integration tests
cargo fmt --all
cargo clippy --workspace --all-targets
```

`apps/desktop/scripts/ui-preview.mjs` (`pnpm preview:ui`) renders the UI in
Edge with a stubbed IPC bridge for quick visual checks. It is a development aid
only; behavior must be verified with the real app and `tests/e2e/run.mjs`.

## Pull requests

- Keep PRs focused; describe what changed and how you verified it.
- CI must pass: lint, unit tests, Rust tests, packaging and the E2E test.
- Update `docs/PROGRESS.md` when you complete a checklist item.

By contributing you agree that your contributions are licensed under the MIT
License.
