# Security Policy

Wmux runs shells and will later automate browsers and AI agents, so we treat
security reports seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability
reporting ("Report a vulnerability" under the repository's Security tab).
Include steps to reproduce and the affected version.

## Design principles

- Processes are launched with `CreateProcessW` and MSVC-correct argument
  quoting, never through a shell command string.
- Every terminal runs inside a Job Object that is killed together with Wmux.
- The frontend can only call an explicit list of backend commands, and their
  input is validated (environment variable names, IDs, snapshot structure).
- No secrets, tokens, passwords or cookies are stored in the SQLite database.
  Workspace environment variables are stored in plain text, and the UI says so.
- Wmux opens no network listener. The planned automation API will use a local
  named pipe with explicit authentication.
