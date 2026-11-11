-- Wmux schema v1: workspaces, recursive layouts, panes, surfaces, terminals,
-- settings and session history.

CREATE TABLE workspaces (
    id                    TEXT PRIMARY KEY,
    name                  TEXT NOT NULL,
    color                 TEXT NOT NULL,
    icon                  TEXT,
    cwd                   TEXT,
    pinned                INTEGER NOT NULL DEFAULT 0,
    position              INTEGER NOT NULL,
    -- Recursive split tree; leaves reference rows in `panes`.
    layout_json           TEXT NOT NULL,
    focused_pane_id       TEXT,
    shell_profile_id      TEXT,
    startup_commands_json TEXT NOT NULL DEFAULT '[]',
    env_json              TEXT NOT NULL DEFAULT '{}',
    created_at            INTEGER NOT NULL,
    updated_at            INTEGER NOT NULL
);

CREATE TABLE panes (
    id                TEXT PRIMARY KEY,
    workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    active_surface_id TEXT,
    position          INTEGER NOT NULL
);
CREATE INDEX idx_panes_workspace ON panes(workspace_id);

CREATE TABLE surfaces (
    id           TEXT PRIMARY KEY,
    pane_id      TEXT NOT NULL REFERENCES panes(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL CHECK (kind IN ('terminal', 'browser')),
    title        TEXT NOT NULL,
    custom_title INTEGER NOT NULL DEFAULT 0,
    position     INTEGER NOT NULL
);
CREATE INDEX idx_surfaces_pane ON surfaces(pane_id);

-- Terminal configuration saved from the UI.
CREATE TABLE terminal_sessions (
    surface_id       TEXT PRIMARY KEY REFERENCES surfaces(id) ON DELETE CASCADE,
    shell_profile_id TEXT,
    cwd              TEXT
);

-- Facts about the last process that ran in each terminal surface, written by
-- the backend. No foreign key: a terminal can start before the UI's debounced
-- autosave has written its surface row. Orphans are removed on save.
CREATE TABLE terminal_runs (
    surface_id TEXT PRIMARY KEY,
    pid        INTEGER NOT NULL,
    program    TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    exit_code  INTEGER,
    exited_at  INTEGER
);

CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Small UI state blobs (active workspace, sidebar width, ...).
CREATE TABLE app_state (
    key        TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
);

CREATE TABLE session_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    at           INTEGER NOT NULL,
    kind         TEXT NOT NULL,
    workspace_id TEXT,
    surface_id   TEXT,
    detail_json  TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_history_at ON session_history(at);
