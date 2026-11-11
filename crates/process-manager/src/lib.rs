//! Process manager for terminal sessions.
//!
//! Each session is a ConPTY-hosted process serviced by three threads:
//!
//! * **reader** – blocking reads from the pseudo console output pipe; every
//!   chunk is forwarded to the session's [`EventSink`]. When the pipe reaches
//!   EOF it emits [`SessionEvent::Exited`]. Because EOF only happens after the
//!   console is closed, all output is always delivered *before* the exit event.
//! * **writer** – drains an unbounded queue into the input pipe, so callers
//!   (Tauri commands, IPC) never block on a slow or stuck child.
//! * **waiter** – waits for the child to exit, records the exit code, then
//!   closes the pseudo console so the reader can finish.
//!
//! None of these run on the UI thread. Dropping/closing a session kills the
//! whole process tree via the job object owned by [`wmux_conpty::Pty`].

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use wmux_conpty::{spawn as spawn_pty, Pty};
pub use wmux_conpty::{CommandSpec, PtySize};

/// Events emitted by a session, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionEvent {
    /// Raw VT output bytes (may split UTF-8 sequences across chunks).
    Output(Vec<u8>),
    /// The process exited. `code` is `None` only if it could not be queried.
    Exited { code: Option<u32> },
}

/// Receives session events on the reader thread. Implementations must be
/// cheap and non-blocking (e.g. push into a channel).
pub type EventSink = Box<dyn Fn(SessionEvent) + Send + Sync + 'static>;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub pid: u32,
    pub program: String,
    pub started_at_ms: u64,
    pub exit_code: Option<u32>,
    pub running: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum ProcessError {
    #[error("session '{0}' already exists and is still running")]
    AlreadyRunning(String),
    #[error("no session with id '{0}'")]
    NotFound(String),
    #[error("session '{0}' has exited")]
    Exited(String),
    #[error(transparent)]
    Pty(#[from] wmux_conpty::PtyError),
    #[error("failed to start thread: {0}")]
    Thread(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, ProcessError>;

struct Session {
    pty: Arc<Pty>,
    input: Sender<Vec<u8>>,
    program: String,
    started_at_ms: u64,
    exit_code: Arc<OnceLock<u32>>,
}

impl Session {
    fn info(&self, id: &str) -> SessionInfo {
        let exit_code = self.exit_code.get().copied();
        SessionInfo {
            id: id.to_string(),
            pid: self.pty.pid(),
            program: self.program.clone(),
            started_at_ms: self.started_at_ms,
            exit_code,
            running: exit_code.is_none(),
        }
    }
}

/// Thread-safe registry of terminal sessions keyed by caller-chosen IDs
/// (Wmux uses the terminal surface ID).
#[derive(Default)]
pub struct ProcessManager {
    sessions: Mutex<HashMap<String, Session>>,
}

const READ_CHUNK: usize = 64 * 1024;
/// How long a graceful close waits for the shell to exit after the console
/// is closed (CTRL_CLOSE_EVENT) before the process tree is killed.
const GRACEFUL_CLOSE_TIMEOUT: Duration = Duration::from_millis(1500);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl ProcessManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Session>> {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Spawn a new session. If a session with the same ID exists but has
    /// already exited it is replaced (this is how "restart" works).
    pub fn spawn(
        &self,
        id: &str,
        spec: &CommandSpec,
        size: PtySize,
        sink: EventSink,
    ) -> Result<SessionInfo> {
        {
            let sessions = self.lock();
            if let Some(existing) = sessions.get(id) {
                if existing.exit_code.get().is_none() {
                    return Err(ProcessError::AlreadyRunning(id.to_string()));
                }
            }
        }

        let (pty, mut reader, mut writer) = spawn_pty(spec, size)?;
        let pty = Arc::new(pty);
        let exit_code = Arc::new(OnceLock::new());
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let short_id: String = id.chars().take(8).collect();

        // Writer thread: exits when the sender is dropped or the pipe breaks.
        thread::Builder::new()
            .name(format!("pty-writer-{short_id}"))
            .spawn(move || {
                for data in rx {
                    if writer
                        .write_all(&data)
                        .and_then(|_| writer.flush())
                        .is_err()
                    {
                        break;
                    }
                }
            })?;

        // Waiter thread: exit code first, then close the console => reader EOF.
        {
            let pty = Arc::clone(&pty);
            let exit_code = Arc::clone(&exit_code);
            thread::Builder::new()
                .name(format!("pty-waiter-{short_id}"))
                .spawn(move || {
                    if let Ok(code) = pty.wait() {
                        let _ = exit_code.set(code);
                    }
                    pty.close_console();
                })?;
        }

        // Reader thread.
        {
            let exit_code = Arc::clone(&exit_code);
            let pty = Arc::clone(&pty);
            thread::Builder::new()
                .name(format!("pty-reader-{short_id}"))
                .spawn(move || {
                    let mut buf = vec![0u8; READ_CHUNK];
                    loop {
                        match reader.read(&mut buf) {
                            Ok(0) => break,
                            Ok(n) => sink(SessionEvent::Output(buf[..n].to_vec())),
                            Err(e) => {
                                log::debug!("pty read ended: {e}");
                                break;
                            }
                        }
                    }
                    // EOF can also be caused by close() before the waiter ran;
                    // make sure we report a real exit code when available.
                    let code = exit_code
                        .get()
                        .copied()
                        .or_else(|| pty.wait_timeout(Duration::from_secs(2)));
                    if let Some(code) = code {
                        let _ = exit_code.set(code);
                    }
                    sink(SessionEvent::Exited { code });
                })?;
        }

        let session = Session {
            pty,
            input: tx,
            program: spec.program.clone(),
            started_at_ms: now_ms(),
            exit_code,
        };
        let info = session.info(id);
        // Replacing an exited session drops its handles here.
        self.lock().insert(id.to_string(), session);
        Ok(info)
    }

    /// Queue input bytes for the session. Never blocks.
    pub fn write(&self, id: &str, data: Vec<u8>) -> Result<()> {
        let sessions = self.lock();
        let session = sessions
            .get(id)
            .ok_or_else(|| ProcessError::NotFound(id.to_string()))?;
        if session.exit_code.get().is_some() {
            return Err(ProcessError::Exited(id.to_string()));
        }
        session
            .input
            .send(data)
            .map_err(|_| ProcessError::Exited(id.to_string()))
    }

    pub fn resize(&self, id: &str, size: PtySize) -> Result<()> {
        let sessions = self.lock();
        let session = sessions
            .get(id)
            .ok_or_else(|| ProcessError::NotFound(id.to_string()))?;
        session.pty.resize(size)?;
        Ok(())
    }

    /// Forcefully kill the session's process tree. The session stays
    /// registered (exited) so its final state can still be queried.
    pub fn kill(&self, id: &str) -> Result<()> {
        let pty = {
            let sessions = self.lock();
            let session = sessions
                .get(id)
                .ok_or_else(|| ProcessError::NotFound(id.to_string()))?;
            Arc::clone(&session.pty)
        };
        pty.kill()?;
        Ok(())
    }

    /// Gracefully close and unregister a session: close the console (the
    /// shell receives CTRL_CLOSE_EVENT), then kill the tree if it is still
    /// alive after a timeout. Runs in the background; returns immediately.
    pub fn close(&self, id: &str) -> Result<()> {
        let session = self
            .lock()
            .remove(id)
            .ok_or_else(|| ProcessError::NotFound(id.to_string()))?;
        thread::Builder::new()
            .name("pty-close".into())
            .spawn(move || {
                let Session { pty, input, .. } = session;
                drop(input);
                if pty.try_wait().is_none() {
                    pty.close_console();
                    if pty.wait_timeout(GRACEFUL_CLOSE_TIMEOUT).is_none() {
                        let _ = pty.kill();
                    }
                }
            })?;
        Ok(())
    }

    pub fn info(&self, id: &str) -> Option<SessionInfo> {
        self.lock().get(id).map(|s| s.info(id))
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        self.lock().iter().map(|(id, s)| s.info(id)).collect()
    }

    /// Kill every session immediately (application shutdown).
    pub fn shutdown_all(&self) {
        let sessions: Vec<Session> = self.lock().drain().map(|(_, s)| s).collect();
        for s in &sessions {
            let _ = s.pty.kill();
        }
    }
}

impl Drop for ProcessManager {
    fn drop(&mut self) {
        self.shutdown_all();
    }
}
