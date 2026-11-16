//! In-app updates.
//!
//! New versions are read from the latest GitHub release (`latest.json`, see
//! `plugins.updater` in tauri.conf.json). Every download is verified against
//! the public key built into the app before it is run.

use std::sync::atomic::Ordering;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::commands::AppState;

/// Where to get a new version by hand.
const DOWNLOAD_PAGE: &str = "https://github.com/SahinurDEV/wmux/releases/latest";

/// An update that has been downloaded and verified but not installed yet.
#[derive(Default)]
pub struct Pending(Mutex<Option<(Update, Vec<u8>)>>);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
    /// Whether this copy can install the update itself. Only copies set up by
    /// the installer (`*-setup.exe`) can; MSI and portable copies get a link.
    can_install: bool,
    download_page: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

/// The installer puts `uninstall.exe` beside the app; nothing else does.
fn installed_by_setup() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|exe| Some(exe.parent()?.join("uninstall.exe").is_file()))
        .unwrap_or(false)
}

/// Updates are off in development builds and under test.
fn enabled() -> bool {
    !cfg!(debug_assertions) && std::env::var_os("WMUX_E2E").is_none()
}

/// The newer version on offer, if there is one.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    if !enabled() {
        return Ok(None);
    }
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?;
    Ok(update.map(|u| UpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone().filter(|b| !b.trim().is_empty()),
        can_install: installed_by_setup(),
        download_page: DOWNLOAD_PAGE,
    }))
}

/// Download the update and verify its signature. Nothing is changed yet, so
/// a failed download leaves the app running as it was. Progress is sent as
/// `update-progress` events.
#[tauri::command]
pub async fn update_download(app: AppHandle, pending: State<'_, Pending>) -> Result<(), String> {
    if !enabled() || !installed_by_setup() {
        return Err("this copy of Wmux cannot update itself".into());
    }
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Err("no update is available".into());
    };
    log::info!("downloading update {}", update.version);
    let mut downloaded = 0u64;
    let progress = app.clone();
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress.emit("update-progress", Progress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    *pending
        .0
        .lock()
        .map_err(|_| "update state is unavailable")? = Some((update, bytes));
    Ok(())
}

/// Install the downloaded update: close the terminals and hand over to the
/// installer, which starts the new version. The frontend saves the session
/// before calling this.
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    state: State<'_, AppState>,
    pending: State<'_, Pending>,
) -> Result<(), String> {
    let taken = pending
        .0
        .lock()
        .map_err(|_| "update state is unavailable")?
        .take();
    let Some((update, bytes)) = taken else {
        return Err("no update has been downloaded".into());
    };
    // Same order as a normal exit: stop the agent scan first so agents are
    // not recorded as gone, then end the terminal process trees. The
    // installer replaces the running program, which exits inside `install`.
    log::info!("installing update {}", update.version);
    state.agents.stop.store(true, Ordering::Relaxed);
    state.processes.shutdown_all();
    update.install(bytes).map_err(|e| e.to_string())?;
    app.restart();
}
