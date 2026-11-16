-- Wmux schema v2: what is needed to bring a terminal back after the app (or
-- the whole PC) restarts: its scrollback text and, if a coding agent was
-- running in it, the agent's own session id so it can be resumed.
--
-- No foreign key, like `terminal_runs`: rows can be written before the UI's
-- debounced autosave has created the surface row. Orphans are removed on save.
CREATE TABLE terminal_restore (
    surface_id       TEXT PRIMARY KEY,
    -- Serialized terminal buffer (VT text), written by the UI.
    scrollback       TEXT,
    scrollback_at    INTEGER,
    -- Command line that was still running when the state was last saved
    -- (reported by shell integration), so it can be started again.
    running_command  TEXT,
    -- Agent detected in this terminal by the backend ('claude', 'codex').
    agent            TEXT,
    agent_session_id TEXT,
    agent_cwd        TEXT,
    agent_at         INTEGER
);
