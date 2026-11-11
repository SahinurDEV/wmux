//! Safe wrapper around the Windows Pseudo Console (ConPTY) API.
//!
//! A [`Pty`] owns three kernel objects:
//!
//! * the pseudo console (`HPCON`), which hosts the terminal state in a
//!   `conhost`/`OpenConsole` process and translates console API calls made by
//!   the child into VT sequences on the output pipe;
//! * the child process handle;
//! * a Job Object containing the child and every descendant it spawns. The job
//!   is created with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so dropping the
//!   [`Pty`] (or the host process crashing) tears down the whole process tree
//!   and never leaves orphaned shells behind.
//!
//! I/O happens on the returned [`PtyReader`] / [`PtyWriter`] (anonymous pipes)
//! which are plain blocking [`std::fs::File`]s. Callers are expected to service
//! them from dedicated threads; see the `wmux-process-manager` crate.
//!
//! Important ConPTY rule: the output pipe must keep being drained while
//! [`Pty::close_console`] runs, otherwise `ClosePseudoConsole` can block on
//! older Windows 10 builds. Never call it from the reader thread.

use std::ffi::OsString;
use std::path::PathBuf;

mod cmdline;
pub use cmdline::{build_command_line, quote_arg};

/// Terminal dimensions in character cells.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PtySize {
    pub cols: u16,
    pub rows: u16,
}

impl PtySize {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            cols: cols.clamp(1, i16::MAX as u16),
            rows: rows.clamp(1, i16::MAX as u16),
        }
    }
}

impl Default for PtySize {
    fn default() -> Self {
        Self {
            cols: 120,
            rows: 30,
        }
    }
}

/// Description of the process to launch inside the pseudo console.
///
/// Arguments are quoted with the MSVC C runtime rules, never passed through a
/// shell, so argument values cannot inject additional commands.
#[derive(Debug, Clone, Default)]
pub struct CommandSpec {
    /// Executable name or path. Bare names are resolved through `PATH`.
    pub program: String,
    pub args: Vec<String>,
    /// Working directory. Must exist if provided.
    pub cwd: Option<PathBuf>,
    /// Environment overrides applied on top of the inherited environment.
    /// A `None` value removes the variable.
    pub env: Vec<(OsString, Option<OsString>)>,
}

impl CommandSpec {
    pub fn new(program: impl Into<String>) -> Self {
        Self {
            program: program.into(),
            ..Default::default()
        }
    }

    pub fn arg(mut self, arg: impl Into<String>) -> Self {
        self.args.push(arg.into());
        self
    }

    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }

    pub fn cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    pub fn env(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.env.push((key.into(), Some(value.into())));
        self
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PtyError {
    #[error("{op} failed: {source}")]
    Win32 {
        op: &'static str,
        #[source]
        source: std::io::Error,
    },
    #[error("working directory does not exist or is not a directory: {0}")]
    InvalidCwd(PathBuf),
    #[error("program must not be empty")]
    EmptyProgram,
    #[error("argument contains a NUL character")]
    NulInArgument,
    #[error("ConPTY is only available on Windows")]
    Unsupported,
}

pub type Result<T> = std::result::Result<T, PtyError>;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::{spawn, Pty, PtyReader, PtyWriter};

#[cfg(not(windows))]
pub fn spawn(_spec: &CommandSpec, _size: PtySize) -> Result<std::convert::Infallible> {
    Err(PtyError::Unsupported)
}
