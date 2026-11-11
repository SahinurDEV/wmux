// Hide the console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod shells;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{Manager, WindowEvent};
use wmux_process_manager::ProcessManager;
use wmux_session_manager::Store;

use commands::AppState;

fn main() {
    tauri::Builder::default()
        // Must be first: a second launch focuses the existing window instead of
        // opening a second instance that would fight over the database.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // WMUX_DATA_DIR lets tests and portable installs keep data elsewhere.
            let data_dir = match std::env::var_os("WMUX_DATA_DIR") {
                Some(dir) => std::path::PathBuf::from(dir),
                None => app.path().app_data_dir()?,
            };
            let (store, outcome) = Store::open(data_dir.join("wmux.db"))?;
            if let Some(from) = &outcome.recovered_from {
                log::error!("database was unusable and moved to {}", from.display());
            }
            let _ = store.prune_history(10_000);
            app.manage(AppState {
                processes: Arc::new(ProcessManager::new()),
                store: Arc::new(Mutex::new(store)),
                db: outcome,
                data_dir,
            });

            // The window starts hidden to avoid a white flash; the frontend shows
            // it after the first paint. Safety net in case the frontend fails.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(5));
                if let Some(w) = handle.get_webview_window("main") {
                    if !w.is_visible().unwrap_or(true) {
                        log::warn!("frontend did not show the window; showing it now");
                        let _ = w.show();
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    // Kill all terminal process trees on exit.
                    window.state::<AppState>().processes.shutdown_all();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::list_shell_profiles,
            commands::pty_spawn,
            commands::pty_write,
            commands::pty_write_binary,
            commands::pty_resize,
            commands::pty_kill,
            commands::pty_close,
            commands::pty_list,
            commands::session_load,
            commands::session_save,
            commands::settings_get,
            commands::settings_set,
            commands::db_backup,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Wmux");
}
