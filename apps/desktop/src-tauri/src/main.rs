// Hide the console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agents;
mod commands;
mod shells;
mod updates;

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{Emitter, Manager, WindowEvent};
use wmux_process_manager::ProcessManager;
use wmux_session_manager::Store;

use commands::AppState;

fn main() {
    let mut builder = tauri::Builder::default();
    // Must be first: a second launch focuses the existing window instead of
    // opening a second instance that would fight over the database. Test runs
    // keep their data in their own folder, so they may run beside an installed
    // copy.
    if std::env::var_os("WMUX_E2E").is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }
    builder
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
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
            let processes = Arc::new(ProcessManager::new());
            let store = Arc::new(Mutex::new(store));
            // Watches for coding agents in terminals: shows them in the UI and
            // remembers their sessions so they can be resumed after a restart.
            let agents = match app.path().home_dir() {
                Ok(home) => {
                    let handle = app.handle().clone();
                    agents::start_scanner(
                        Arc::clone(&processes),
                        Arc::clone(&store),
                        home,
                        move |live| {
                            if let Err(e) = handle.emit("agents-changed", live) {
                                log::warn!("could not publish agent state: {e}");
                            }
                        },
                    )
                }
                Err(e) => {
                    log::warn!("no home directory ({e}); agents will not be detected");
                    agents::Scanner::default()
                }
            };
            app.manage(updates::Pending::default());
            app.manage(AppState {
                processes,
                store,
                db: outcome,
                data_dir,
                agents,
            });

            // The window is built here rather than from the config alone so
            // that tests can ask the browser for a DevTools port. The
            // environment variable WebView2 offers for this is not honored
            // everywhere (it is ignored on GitHub's runners).
            let window_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .cloned()
                .ok_or("no main window in tauri.conf.json")?;
            let mut window = tauri::WebviewWindowBuilder::from_config(app.handle(), &window_config)?;
            if std::env::var_os("WMUX_E2E").is_some() {
                // Setting any argument replaces the defaults, so they are repeated.
                window = window.additional_browser_args(
                    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port=0",
                );
            }
            window.build()?;

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
                    let state = window.state::<AppState>();
                    // Stop the scan first so the agents killed below are not
                    // recorded as "exited" and forgotten.
                    state.agents.stop.store(true, Ordering::Relaxed);
                    // Kill all terminal process trees on exit.
                    state.processes.shutdown_all();
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
            commands::agents_get,
            commands::terminal_restore_get,
            commands::terminal_state_save,
            commands::settings_get,
            commands::settings_set,
            commands::db_backup,
            updates::update_check,
            updates::update_download,
            updates::update_install,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Wmux");
}
