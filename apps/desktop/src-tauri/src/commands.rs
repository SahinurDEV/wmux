//! Tauri commands exposed to the frontend.
//!
//! All commands are `async` so Tauri runs them on its async runtime rather
//! than the main (UI) thread. Long-lived work (PTY I/O) happens on threads
//! owned by `wmux-process-manager`.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, Response};
use tauri::{Manager, State};
use wmux_process_manager::{
    CommandSpec, EventSink, ProcessError, ProcessManager, PtySize, SessionEvent, SessionInfo,
};
use wmux_session_manager::{OpenOutcome, SessionSnapshot, Store, StoreError};

use crate::shells::{self, CustomProfile, ShellProfile};

pub struct AppState {
    pub processes: Arc<ProcessManager>,
    pub store: Arc<Mutex<Store>>,
    pub db: OpenOutcome,
    pub data_dir: PathBuf,
}

/// Error returned to the frontend as `{ kind, message }`.
#[derive(Debug, Serialize)]
pub struct CmdError {
    pub kind: &'static str,
    pub message: String,
}

impl CmdError {
    fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl From<ProcessError> for CmdError {
    fn from(e: ProcessError) -> Self {
        let kind = match e {
            ProcessError::NotFound(_) => "notFound",
            ProcessError::Exited(_) => "exited",
            ProcessError::AlreadyRunning(_) => "alreadyRunning",
            ProcessError::Pty(_) => "spawnFailed",
            ProcessError::Thread(_) => "internal",
        };
        Self::new(kind, e.to_string())
    }
}

impl From<StoreError> for CmdError {
    fn from(e: StoreError) -> Self {
        log::error!("store error: {e}");
        Self::new("database", e.to_string())
    }
}

type CmdResult<T> = Result<T, CmdError>;

fn lock_store(state: &AppState) -> CmdResult<std::sync::MutexGuard<'_, Store>> {
    state
        .store
        .lock()
        .map_err(|_| CmdError::new("internal", "database lock poisoned"))
}

// ------------------------------------------------------------------- app

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    db_path: PathBuf,
    db_recovered_from: Option<PathBuf>,
    db_recovery_reason: Option<String>,
    e2e: bool,
    home_dir: Option<PathBuf>,
}

#[tauri::command]
pub async fn app_info(app: tauri::AppHandle, state: State<'_, AppState>) -> CmdResult<AppInfo> {
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        db_path: state.db.path.clone(),
        db_recovered_from: state.db.recovered_from.clone(),
        db_recovery_reason: state.db.recovery_reason.clone(),
        e2e: std::env::var_os("WMUX_E2E").is_some(),
        home_dir: app.path().home_dir().ok(),
    })
}

// ---------------------------------------------------------------- shells

fn custom_profiles(state: &AppState) -> Vec<CustomProfile> {
    let Ok(store) = state.store.lock() else {
        return Vec::new();
    };
    store
        .get_settings()
        .ok()
        .and_then(|s| s.get("terminal.customProfiles").cloned())
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn list_shell_profiles(state: State<'_, AppState>) -> CmdResult<Vec<ShellProfile>> {
    Ok(shells::detect(&custom_profiles(&state)))
}

// ------------------------------------------------------------------- pty

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnRequest {
    surface_id: String,
    workspace_id: String,
    profile_id: Option<String>,
    cwd: Option<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    cols: u16,
    rows: u16,
    #[serde(default = "default_true")]
    shell_integration: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnResult {
    session: SessionInfo,
    profile: ShellProfile,
    cwd: Option<String>,
    /// Set when the requested directory was missing and home was used instead.
    cwd_fallback_from: Option<String>,
}

/// Message tags on the PTY event channel. Output and exit share one channel so
/// the frontend receives them strictly in order.
const TAG_OUTPUT: u8 = 0;
const TAG_EXIT: u8 = 1;

fn validate_env_key(key: &str) -> CmdResult<()> {
    if key.is_empty() || key.contains(['=', '\0']) || key.len() > 256 {
        return Err(CmdError::new(
            "invalidRequest",
            format!("invalid environment variable name: {key:?}"),
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn pty_spawn(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: SpawnRequest,
    on_event: Channel<Response>,
) -> CmdResult<SpawnResult> {
    let profiles = shells::detect(&custom_profiles(&state));
    let profile = match &request.profile_id {
        Some(id) => profiles.iter().find(|p| &p.id == id).cloned().ok_or_else(|| {
            CmdError::new("profileNotFound", format!("shell profile '{id}' is not available"))
        })?,
        None => profiles
            .first()
            .cloned()
            .ok_or_else(|| CmdError::new("profileNotFound", "no shell found on this system"))?,
    };

    let launch = shells::launch_for(&profile, request.shell_integration);

    // Working directory: fall back to home if the saved one no longer exists.
    let home = app.path().home_dir().ok();
    let mut cwd_fallback_from = None;
    let cwd = match request.cwd.as_deref().filter(|c| !c.trim().is_empty()) {
        Some(c) if PathBuf::from(c).is_dir() => Some(PathBuf::from(c)),
        Some(c) => {
            cwd_fallback_from = Some(c.to_string());
            home.clone()
        }
        None => home.clone(),
    };

    let mut spec = CommandSpec::new(launch.program.clone()).args(launch.args);
    if let Some(cwd) = &cwd {
        spec = spec.cwd(cwd);
    }
    spec = spec
        .env("TERM", "xterm-256color")
        .env("COLORTERM", "truecolor")
        .env("TERM_PROGRAM", "Wmux")
        .env("TERM_PROGRAM_VERSION", app.package_info().version.to_string())
        .env("WMUX_SURFACE_ID", &request.surface_id)
        .env("WMUX_WORKSPACE_ID", &request.workspace_id);
    for (k, v) in launch.extra_env {
        spec = spec.env(k, v);
    }
    for (k, v) in &request.env {
        validate_env_key(k)?;
        if v.contains('\0') {
            return Err(CmdError::new("invalidRequest", format!("value of {k} contains NUL")));
        }
        spec = spec.env(k, v);
    }

    let store = Arc::clone(&state.store);
    let surface_id = request.surface_id.clone();
    let sink: EventSink = Box::new(move |event| match event {
        SessionEvent::Output(bytes) => {
            let mut msg = Vec::with_capacity(bytes.len() + 1);
            msg.push(TAG_OUTPUT);
            msg.extend_from_slice(&bytes);
            let _ = on_event.send(Response::new(msg));
        }
        SessionEvent::Exited { code } => {
            if let Ok(s) = store.lock() {
                if let Err(e) = s.record_terminal_exited(&surface_id, code) {
                    log::warn!("failed to record exit: {e}");
                }
            }
            let mut msg = vec![TAG_EXIT];
            msg.extend(serde_json::to_vec(&serde_json::json!({ "code": code })).unwrap_or_default());
            let _ = on_event.send(Response::new(msg));
        }
    });

    let session = state.processes.spawn(
        &request.surface_id,
        &spec,
        PtySize::new(request.cols, request.rows),
        sink,
    )?;
    log::info!(
        "spawned {} (pid {}) for surface {}",
        profile.name,
        session.pid,
        request.surface_id
    );
    if let Ok(s) = state.store.lock() {
        if let Err(e) = s.record_terminal_started(&request.surface_id, session.pid, &profile.program)
        {
            log::warn!("failed to record start: {e}");
        }
    }

    Ok(SpawnResult {
        session,
        profile,
        cwd: cwd.map(|c| c.to_string_lossy().into_owned()),
        cwd_fallback_from,
    })
}

#[tauri::command]
pub async fn pty_write(state: State<'_, AppState>, id: String, data: String) -> CmdResult<()> {
    Ok(state.processes.write(&id, data.into_bytes())?)
}

#[tauri::command]
pub async fn pty_write_binary(state: State<'_, AppState>, id: String, data: Vec<u8>) -> CmdResult<()> {
    Ok(state.processes.write(&id, data)?)
}

#[tauri::command]
pub async fn pty_resize(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> CmdResult<()> {
    Ok(state.processes.resize(&id, PtySize::new(cols, rows))?)
}

#[tauri::command]
pub async fn pty_kill(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    Ok(state.processes.kill(&id)?)
}

/// Gracefully close and unregister a session (no error if it is unknown).
#[tauri::command]
pub async fn pty_close(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    match state.processes.close(&id) {
        Ok(()) | Err(ProcessError::NotFound(_)) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

#[tauri::command]
pub async fn pty_list(state: State<'_, AppState>) -> CmdResult<Vec<SessionInfo>> {
    Ok(state.processes.list())
}

// --------------------------------------------------------------- session

#[tauri::command]
pub async fn session_load(state: State<'_, AppState>) -> CmdResult<SessionSnapshot> {
    Ok(lock_store(&state)?.load_snapshot()?)
}

#[tauri::command]
pub async fn session_save(state: State<'_, AppState>, snapshot: SessionSnapshot) -> CmdResult<()> {
    Ok(lock_store(&state)?.save_snapshot(&snapshot)?)
}

#[tauri::command]
pub async fn settings_get(
    state: State<'_, AppState>,
) -> CmdResult<BTreeMap<String, serde_json::Value>> {
    Ok(lock_store(&state)?.get_settings()?)
}

#[tauri::command]
pub async fn settings_set(
    state: State<'_, AppState>,
    values: BTreeMap<String, serde_json::Value>,
) -> CmdResult<()> {
    if values.keys().any(|k| k.is_empty() || k.len() > 128) {
        return Err(CmdError::new("invalidRequest", "invalid settings key"));
    }
    Ok(lock_store(&state)?.set_settings(&values)?)
}

/// Back up the database to `<app data>/backups/wmux-<timestamp>.db`.
#[tauri::command]
pub async fn db_backup(state: State<'_, AppState>) -> CmdResult<PathBuf> {
    let dir = state.data_dir.join("backups");
    std::fs::create_dir_all(&dir).map_err(|e| CmdError::new("io", e.to_string()))?;
    let dest = dir.join(format!("wmux-{}.db", wmux_session_manager::now_ms()));
    lock_store(&state)?.backup_to(&dest)?;
    Ok(dest)
}
