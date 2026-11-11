//! SQLite-backed persistence for Wmux.
//!
//! * Schema is versioned with `PRAGMA user_version` and forward-only
//!   migrations embedded from `migrations/`.
//! * [`Store::save_snapshot`] upserts the UI's workspace model and deletes
//!   rows that no longer exist, all in one transaction. Runtime columns that
//!   the UI does not own (last PID, exit code) are preserved.
//! * If the database cannot be opened or fails its integrity check, it is
//!   moved aside and a fresh one is created ([`OpenOutcome::recovered_from`]).
//!
//! Secrets are never stored here: no tokens, passwords or cookies.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};

const MIGRATIONS: &[(i64, &str)] = &[(1, include_str!("../migrations/0001_initial.sql"))];

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("invalid JSON in column {column}: {source}")]
    Json {
        column: &'static str,
        #[source]
        source: serde_json::Error,
    },
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid snapshot: {0}")]
    Invalid(String),
}

pub type Result<T> = std::result::Result<T, StoreError>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceRecord {
    pub id: String,
    /// `"terminal"` or `"browser"`.
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub custom_title: bool,
    #[serde(default)]
    pub shell_profile_id: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    /// Read-only: facts about the last process (filled on load, ignored on save).
    #[serde(default, skip_deserializing)]
    pub last_run: Option<LastRun>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastRun {
    pub pid: Option<i64>,
    pub program: Option<String>,
    pub started_at: Option<i64>,
    pub exit_code: Option<i64>,
    pub exited_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneRecord {
    pub id: String,
    pub active_surface_id: Option<String>,
    pub surfaces: Vec<SurfaceRecord>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecord {
    pub id: String,
    pub name: String,
    pub color: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub pinned: bool,
    /// Recursive split tree (validated by the UI, stored opaquely).
    pub layout: serde_json::Value,
    #[serde(default)]
    pub focused_pane_id: Option<String>,
    #[serde(default)]
    pub shell_profile_id: Option<String>,
    #[serde(default)]
    pub startup_commands: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub panes: Vec<PaneRecord>,
    #[serde(default)]
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    /// Ordered as displayed in the sidebar.
    pub workspaces: Vec<WorkspaceRecord>,
    #[serde(default)]
    pub active_workspace_id: Option<String>,
    /// Free-form UI state (sidebar width, collapsed, ...).
    #[serde(default)]
    pub ui: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenOutcome {
    pub path: PathBuf,
    /// If the previous DB was unusable, where it was moved to.
    pub recovered_from: Option<PathBuf>,
    pub recovery_reason: Option<String>,
}

pub struct Store {
    conn: Connection,
    path: Option<PathBuf>,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn configure(conn: &Connection) -> Result<()> {
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "busy_timeout", 5000)?;
    // WAL is not available for in-memory databases; ignore the result there.
    let _: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    Ok(())
}

fn migrate(conn: &mut Connection) -> Result<()> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (version, sql) in MIGRATIONS {
        if *version > current {
            let tx = conn.transaction()?;
            tx.execute_batch(sql)?;
            tx.pragma_update(None, "user_version", version)?;
            tx.commit()?;
            log::info!("applied database migration v{version}");
        }
    }
    Ok(())
}

fn json_col<T: serde::de::DeserializeOwned>(column: &'static str, s: &str) -> Result<T> {
    serde_json::from_str(s).map_err(|source| StoreError::Json { column, source })
}

fn to_json<T: Serialize>(column: &'static str, v: &T) -> Result<String> {
    serde_json::to_string(v).map_err(|source| StoreError::Json { column, source })
}

impl Store {
    /// Open (or create) the database at `path`, recovering from corruption by
    /// moving the bad file aside.
    pub fn open(path: impl AsRef<Path>) -> Result<(Self, OpenOutcome)> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        match Self::try_open(&path) {
            Ok(store) => Ok((
                store,
                OpenOutcome {
                    path,
                    recovered_from: None,
                    recovery_reason: None,
                },
            )),
            Err(err) => {
                let reason = err.to_string();
                log::error!("database unusable ({reason}); moving it aside");
                let aside = path.with_extension(format!("corrupt-{}.db", now_ms()));
                std::fs::rename(&path, &aside)?;
                for ext in ["db-wal", "db-shm"] {
                    let side = path.with_extension(ext);
                    if side.exists() {
                        let _ = std::fs::remove_file(side);
                    }
                }
                let store = Self::try_open(&path)?;
                Ok((
                    store,
                    OpenOutcome {
                        path,
                        recovered_from: Some(aside),
                        recovery_reason: Some(reason),
                    },
                ))
            }
        }
    }

    fn try_open(path: &Path) -> Result<Self> {
        let mut conn = Connection::open(path)?;
        configure(&conn)?;
        let check: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        if check != "ok" {
            return Err(StoreError::Invalid(format!(
                "integrity check failed: {check}"
            )));
        }
        migrate(&mut conn)?;
        Ok(Self {
            conn,
            path: Some(path.to_path_buf()),
        })
    }

    pub fn open_in_memory() -> Result<Self> {
        let mut conn = Connection::open_in_memory()?;
        configure(&conn)?;
        migrate(&mut conn)?;
        Ok(Self { conn, path: None })
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub fn schema_version(&self) -> Result<i64> {
        Ok(self
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))?)
    }

    // ---------------------------------------------------------------- snapshot

    pub fn save_snapshot(&mut self, snap: &SessionSnapshot) -> Result<()> {
        validate(snap)?;
        let now = now_ms();
        let tx = self.conn.transaction()?;
        let mut ws_ids = Vec::new();
        let mut pane_ids = Vec::new();
        let mut surface_ids = Vec::new();

        for (pos, ws) in snap.workspaces.iter().enumerate() {
            ws_ids.push(ws.id.clone());
            let created = if ws.created_at > 0 {
                ws.created_at
            } else {
                now
            };
            tx.execute(
                "INSERT INTO workspaces (id, name, color, icon, cwd, pinned, position, layout_json,
                    focused_pane_id, shell_profile_id, startup_commands_json, env_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                 ON CONFLICT(id) DO UPDATE SET name=excluded.name, color=excluded.color, icon=excluded.icon,
                    cwd=excluded.cwd, pinned=excluded.pinned, position=excluded.position,
                    layout_json=excluded.layout_json, focused_pane_id=excluded.focused_pane_id,
                    shell_profile_id=excluded.shell_profile_id,
                    startup_commands_json=excluded.startup_commands_json, env_json=excluded.env_json,
                    updated_at=excluded.updated_at",
                params![
                    ws.id,
                    ws.name,
                    ws.color,
                    ws.icon,
                    ws.cwd,
                    ws.pinned,
                    pos as i64,
                    to_json("layout_json", &ws.layout)?,
                    ws.focused_pane_id,
                    ws.shell_profile_id,
                    to_json("startup_commands_json", &ws.startup_commands)?,
                    to_json("env_json", &ws.env)?,
                    created,
                    now
                ],
            )?;
            for (ppos, pane) in ws.panes.iter().enumerate() {
                pane_ids.push(pane.id.clone());
                tx.execute(
                    "INSERT INTO panes (id, workspace_id, active_surface_id, position) VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id,
                        active_surface_id=excluded.active_surface_id, position=excluded.position",
                    params![pane.id, ws.id, pane.active_surface_id, ppos as i64],
                )?;
                for (spos, s) in pane.surfaces.iter().enumerate() {
                    surface_ids.push(s.id.clone());
                    tx.execute(
                        "INSERT INTO surfaces (id, pane_id, kind, title, custom_title, position)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                         ON CONFLICT(id) DO UPDATE SET pane_id=excluded.pane_id, kind=excluded.kind,
                            title=excluded.title, custom_title=excluded.custom_title, position=excluded.position",
                        params![s.id, pane.id, s.kind, s.title, s.custom_title, spos as i64],
                    )?;
                    if s.kind == "terminal" {
                        tx.execute(
                            "INSERT INTO terminal_sessions (surface_id, shell_profile_id, cwd) VALUES (?1, ?2, ?3)
                             ON CONFLICT(surface_id) DO UPDATE SET shell_profile_id=excluded.shell_profile_id,
                                cwd=excluded.cwd",
                            params![s.id, s.shell_profile_id, s.cwd],
                        )?;
                    }
                }
            }
        }

        delete_missing(&tx, "surfaces", &surface_ids)?;
        delete_missing(&tx, "panes", &pane_ids)?;
        delete_missing(&tx, "workspaces", &ws_ids)?;
        tx.execute(
            "DELETE FROM terminal_runs WHERE surface_id NOT IN (SELECT value FROM json_each(?1))",
            [serde_json::to_string(&surface_ids).expect("string list serializes")],
        )?;

        set_state(&tx, "active_workspace_id", &snap.active_workspace_id)?;
        set_state(&tx, "ui", &snap.ui)?;
        tx.commit()?;
        Ok(())
    }

    pub fn load_snapshot(&self) -> Result<SessionSnapshot> {
        let mut ws_stmt = self.conn.prepare(
            "SELECT id, name, color, icon, cwd, pinned, layout_json, focused_pane_id, shell_profile_id,
                    startup_commands_json, env_json, created_at
             FROM workspaces ORDER BY position, created_at",
        )?;
        let mut pane_stmt = self.conn.prepare(
            "SELECT id, active_surface_id FROM panes WHERE workspace_id = ?1 ORDER BY position",
        )?;
        let mut surf_stmt = self.conn.prepare(
            "SELECT s.id, s.kind, s.title, s.custom_title, t.shell_profile_id, t.cwd,
                    r.pid, r.program, r.started_at, r.exit_code, r.exited_at
             FROM surfaces s
             LEFT JOIN terminal_sessions t ON t.surface_id = s.id
             LEFT JOIN terminal_runs r ON r.surface_id = s.id
             WHERE s.pane_id = ?1 ORDER BY s.position",
        )?;

        let rows = ws_stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, bool>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, Option<String>>(7)?,
                    r.get::<_, Option<String>>(8)?,
                    r.get::<_, String>(9)?,
                    r.get::<_, String>(10)?,
                    r.get::<_, i64>(11)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut workspaces = Vec::with_capacity(rows.len());
        for (id, name, color, icon, cwd, pinned, layout, focused, shell, startup, env, created) in
            rows
        {
            let pane_rows = pane_stmt
                .query_map([&id], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut panes = Vec::new();
            for (pane_id, active) in pane_rows {
                let surfaces = surf_stmt
                    .query_map([&pane_id], |r| {
                        let pid: Option<i64> = r.get(6)?;
                        let started: Option<i64> = r.get(8)?;
                        let last_run = (pid.is_some() || started.is_some()).then(|| LastRun {
                            pid,
                            program: r.get(7).ok().flatten(),
                            started_at: started,
                            exit_code: r.get(9).ok().flatten(),
                            exited_at: r.get(10).ok().flatten(),
                        });
                        Ok(SurfaceRecord {
                            id: r.get(0)?,
                            kind: r.get(1)?,
                            title: r.get(2)?,
                            custom_title: r.get(3)?,
                            shell_profile_id: r.get(4)?,
                            cwd: r.get(5)?,
                            last_run,
                        })
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                panes.push(PaneRecord {
                    id: pane_id,
                    active_surface_id: active,
                    surfaces,
                });
            }
            workspaces.push(WorkspaceRecord {
                id,
                name,
                color,
                icon,
                cwd,
                pinned,
                layout: json_col("layout_json", &layout)?,
                focused_pane_id: focused,
                shell_profile_id: shell,
                startup_commands: json_col("startup_commands_json", &startup)?,
                env: json_col("env_json", &env)?,
                panes,
                created_at: created,
            });
        }

        Ok(SessionSnapshot {
            workspaces,
            active_workspace_id: self.get_state("active_workspace_id")?.flatten(),
            ui: self.get_state("ui")?.unwrap_or(serde_json::Value::Null),
        })
    }

    fn get_state<T: serde::de::DeserializeOwned>(&self, key: &str) -> Result<Option<T>> {
        let raw: Option<String> = self
            .conn
            .query_row(
                "SELECT value_json FROM app_state WHERE key = ?1",
                [key],
                |r| r.get(0),
            )
            .optional()?;
        raw.map(|s| json_col("app_state", &s)).transpose()
    }

    // ------------------------------------------------------- terminal runtime

    pub fn record_terminal_started(&self, surface_id: &str, pid: u32, program: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO terminal_runs (surface_id, pid, program, started_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(surface_id) DO UPDATE SET pid=excluded.pid, program=excluded.program,
                started_at=excluded.started_at, exit_code=NULL, exited_at=NULL",
            params![surface_id, pid as i64, program, now_ms()],
        )?;
        self.append_history(
            "terminal.started",
            None,
            Some(surface_id),
            &serde_json::json!({"pid": pid, "program": program}),
        )?;
        Ok(())
    }

    pub fn record_terminal_exited(&self, surface_id: &str, code: Option<u32>) -> Result<()> {
        self.conn.execute(
            "UPDATE terminal_runs SET exit_code = ?2, exited_at = ?3 WHERE surface_id = ?1",
            params![surface_id, code.map(|c| c as i64), now_ms()],
        )?;
        self.append_history(
            "terminal.exited",
            None,
            Some(surface_id),
            &serde_json::json!({"code": code}),
        )?;
        Ok(())
    }

    // --------------------------------------------------------------- history

    pub fn append_history(
        &self,
        kind: &str,
        workspace_id: Option<&str>,
        surface_id: Option<&str>,
        detail: &serde_json::Value,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO session_history (at, kind, workspace_id, surface_id, detail_json) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![now_ms(), kind, workspace_id, surface_id, detail.to_string()],
        )?;
        Ok(())
    }

    /// Keep the history table bounded.
    pub fn prune_history(&self, keep: i64) -> Result<usize> {
        Ok(self.conn.execute(
            "DELETE FROM session_history WHERE id NOT IN (SELECT id FROM session_history ORDER BY id DESC LIMIT ?1)",
            [keep],
        )?)
    }

    // -------------------------------------------------------------- settings

    pub fn get_settings(&self) -> Result<BTreeMap<String, serde_json::Value>> {
        let mut stmt = self.conn.prepare("SELECT key, value_json FROM settings")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(k, v)| Ok((k, json_col("settings", &v)?)))
            .collect()
    }

    pub fn set_settings(&mut self, values: &BTreeMap<String, serde_json::Value>) -> Result<()> {
        let tx = self.conn.transaction()?;
        let now = now_ms();
        for (k, v) in values {
            tx.execute(
                "INSERT INTO settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
                params![k, v.to_string(), now],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    // ---------------------------------------------------------------- backup

    /// Online backup to `dest` (consistent even while in use).
    pub fn backup_to(&self, dest: impl AsRef<Path>) -> Result<()> {
        let mut dst = Connection::open(dest)?;
        let backup = rusqlite::backup::Backup::new(&self.conn, &mut dst)?;
        backup.run_to_completion(256, std::time::Duration::from_millis(5), None)?;
        Ok(())
    }
}

fn delete_missing(tx: &Transaction<'_>, table: &'static str, keep: &[String]) -> Result<()> {
    let keep = serde_json::to_string(keep).expect("string list serializes");
    tx.execute(
        &format!("DELETE FROM {table} WHERE id NOT IN (SELECT value FROM json_each(?1))"),
        [keep],
    )?;
    Ok(())
}

fn set_state<T: Serialize>(tx: &Transaction<'_>, key: &str, v: &T) -> Result<()> {
    tx.execute(
        "INSERT INTO app_state (key, value_json) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
        params![key, to_json("app_state", v)?],
    )?;
    Ok(())
}

/// Structural validation: unique IDs, known surface kinds, bounded sizes.
pub fn validate(snap: &SessionSnapshot) -> Result<()> {
    use std::collections::HashSet;
    let mut ids = HashSet::new();
    let mut check_id = |id: &str, what: &str| -> Result<()> {
        if id.is_empty() || id.len() > 128 {
            return Err(StoreError::Invalid(format!("{what} id has invalid length")));
        }
        if !ids.insert(id.to_string()) {
            return Err(StoreError::Invalid(format!("duplicate {what} id {id}")));
        }
        Ok(())
    };
    for ws in &snap.workspaces {
        check_id(&ws.id, "workspace")?;
        if ws.name.len() > 200 {
            return Err(StoreError::Invalid("workspace name too long".into()));
        }
        for pane in &ws.panes {
            check_id(&pane.id, "pane")?;
            for s in &pane.surfaces {
                check_id(&s.id, "surface")?;
                if s.kind != "terminal" && s.kind != "browser" {
                    return Err(StoreError::Invalid(format!(
                        "unknown surface kind {}",
                        s.kind
                    )));
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
