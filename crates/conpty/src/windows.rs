use std::collections::BTreeMap;
use std::ffi::{c_void, OsStr, OsString};
use std::fs::File;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::ptr::{null, null_mut};
use std::sync::Mutex;
use std::time::Duration;

use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0};
use windows_sys::Win32::System::Console::{
    ClosePseudoConsole, CreatePseudoConsole, ResizePseudoConsole, COORD, HPCON,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
    InitializeProcThreadAttributeList, ResumeThread, TerminateProcess, UpdateProcThreadAttribute,
    WaitForSingleObject, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
    EXTENDED_STARTUPINFO_PRESENT, INFINITE, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
    PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, STARTF_USESTDHANDLES, STARTUPINFOEXW,
};

use crate::{build_command_line, CommandSpec, PtyError, PtySize, Result};

/// Read side of the pseudo console: VT-encoded output produced by the child.
pub type PtyReader = File;
/// Write side of the pseudo console: input (keystrokes, paste) for the child.
pub type PtyWriter = File;

const STILL_ACTIVE: u32 = 259;

fn win32_err(op: &'static str) -> PtyError {
    PtyError::Win32 {
        op,
        source: std::io::Error::last_os_error(),
    }
}

fn owned(h: HANDLE) -> OwnedHandle {
    // SAFETY: callers only pass freshly created, valid, uniquely owned handles.
    unsafe { OwnedHandle::from_raw_handle(h as _) }
}

fn raw(h: &OwnedHandle) -> HANDLE {
    h.as_raw_handle() as HANDLE
}

fn create_pipe() -> Result<(OwnedHandle, OwnedHandle)> {
    let mut read: HANDLE = null_mut();
    let mut write: HANDLE = null_mut();
    // SAFETY: out-pointers are valid; no inheritance (null security attrs).
    if unsafe { CreatePipe(&mut read, &mut write, null(), 0) } == 0 {
        return Err(win32_err("CreatePipe"));
    }
    Ok((owned(read), owned(write)))
}

fn to_wide(s: &OsStr) -> Vec<u16> {
    s.encode_wide().chain(std::iter::once(0)).collect()
}

/// Build a sorted, double-NUL-terminated UTF-16 environment block from the
/// inherited environment plus `overrides`. Windows variable names are
/// case-insensitive, so the merge is case-insensitive too.
fn build_env_block(overrides: &[(OsString, Option<OsString>)]) -> Vec<u16> {
    let mut vars: BTreeMap<String, (OsString, OsString)> = BTreeMap::new();
    for (k, v) in std::env::vars_os() {
        vars.insert(k.to_string_lossy().to_uppercase(), (k, v));
    }
    for (k, v) in overrides {
        let key = k.to_string_lossy().to_uppercase();
        match v {
            Some(v) => {
                vars.insert(key, (k.clone(), v.clone()));
            }
            None => {
                vars.remove(&key);
            }
        }
    }
    let mut block = Vec::new();
    for (_, (k, v)) in vars {
        block.extend(k.encode_wide());
        block.push(b'=' as u16);
        block.extend(v.encode_wide());
        block.push(0);
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    block
}

/// Pointer-aligned storage for a `PROC_THREAD_ATTRIBUTE_LIST`.
struct AttributeList {
    buf: Vec<usize>,
}

impl AttributeList {
    fn with_pseudoconsole(hpc: HPCON) -> Result<Self> {
        let mut size: usize = 0;
        // First call reports the required size and is expected to "fail".
        unsafe { InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut size) };
        if size == 0 {
            return Err(win32_err("InitializeProcThreadAttributeList(size)"));
        }
        let words = size.div_ceil(std::mem::size_of::<usize>());
        let mut list = Self {
            buf: vec![0usize; words],
        };
        // SAFETY: buffer is at least `size` bytes and pointer-aligned.
        if unsafe { InitializeProcThreadAttributeList(list.ptr(), 1, 0, &mut size) } == 0 {
            // Do not run Delete on a list that failed to initialize.
            let err = win32_err("InitializeProcThreadAttributeList");
            std::mem::forget(list);
            return Err(err);
        }
        // For PSEUDOCONSOLE the attribute *value* is the HPCON itself.
        let ok = unsafe {
            UpdateProcThreadAttribute(
                list.ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                hpc as *const c_void,
                std::mem::size_of::<HPCON>(),
                null_mut(),
                null(),
            )
        };
        if ok == 0 {
            return Err(win32_err("UpdateProcThreadAttribute"));
        }
        Ok(list)
    }

    fn ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.buf.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        unsafe { DeleteProcThreadAttributeList(self.ptr()) };
    }
}

fn create_kill_on_close_job() -> Result<OwnedHandle> {
    let job = unsafe { CreateJobObjectW(null(), null()) };
    if job.is_null() {
        return Err(win32_err("CreateJobObjectW"));
    }
    let job = owned(job);
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let ok = unsafe {
        SetInformationJobObject(
            raw(&job),
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if ok == 0 {
        return Err(win32_err("SetInformationJobObject"));
    }
    Ok(job)
}

/// A running process attached to a Windows pseudo console.
///
/// Dropping a `Pty` closes the pseudo console and the job object, which
/// terminates the child and all of its descendants.
pub struct Pty {
    console: Mutex<Option<HPCON>>,
    process: OwnedHandle,
    job: Option<OwnedHandle>,
    pid: u32,
}

// SAFETY: HPCON is an opaque kernel handle value; all access is serialized
// through the mutex, and ConPTY functions are thread-safe for distinct calls.
unsafe impl Send for Pty {}
unsafe impl Sync for Pty {}

/// Spawn `spec` inside a new pseudo console of the given size.
///
/// Returns the [`Pty`] plus the reader (child output) and writer (child input).
pub fn spawn(spec: &CommandSpec, size: PtySize) -> Result<(Pty, PtyReader, PtyWriter)> {
    if let Some(cwd) = &spec.cwd {
        if !cwd.is_dir() {
            return Err(PtyError::InvalidCwd(cwd.clone()));
        }
    }
    let command_line = build_command_line(&spec.program, &spec.args)?;
    let mut command_line: Vec<u16> = to_wide(OsStr::new(&command_line));
    let env_block = build_env_block(&spec.env);
    let cwd_wide = spec.cwd.as_ref().map(|p| to_wide(p.as_os_str()));

    // in: we write -> conhost reads.  out: conhost writes -> we read.
    let (in_read, in_write) = create_pipe()?;
    let (out_read, out_write) = create_pipe()?;

    let size = PtySize::new(size.cols, size.rows);
    // SAFETY: HPCON is a plain handle value (integer or pointer); zero is "none".
    let mut hpc: HPCON = unsafe { std::mem::zeroed() };
    let hr = unsafe {
        CreatePseudoConsole(
            COORD {
                X: size.cols as i16,
                Y: size.rows as i16,
            },
            raw(&in_read),
            raw(&out_write),
            0,
            &mut hpc,
        )
    };
    if hr < 0 {
        return Err(PtyError::Win32 {
            op: "CreatePseudoConsole",
            source: std::io::Error::from_raw_os_error(hr),
        });
    }
    // From here on, make sure the console is closed on any error path.
    let pty_console = ConsoleGuard(Some(hpc));

    let mut attrs = AttributeList::with_pseudoconsole(hpc)?;

    let mut si: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    // Explicitly invalid std handles: otherwise a child can inherit the host's
    // redirected stdio instead of attaching to the pseudo console.
    si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    si.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
    si.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
    si.StartupInfo.hStdError = INVALID_HANDLE_VALUE;
    si.lpAttributeList = attrs.ptr();

    // Job creation only fails in exotic environments; then only the direct
    // child can be killed.
    let job = create_kill_on_close_job().ok();

    let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let ok = unsafe {
        CreateProcessW(
            null(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            0, // do not inherit handles
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
            env_block.as_ptr() as *const c_void,
            cwd_wide.as_ref().map_or(null(), |w| w.as_ptr()),
            &si.StartupInfo,
            &mut pi,
        )
    };
    if ok == 0 {
        let source = std::io::Error::last_os_error();
        return Err(PtyError::Win32 {
            op: "CreateProcessW",
            source: std::io::Error::new(
                source.kind(),
                format!("{source} (command: {})", spec.program),
            ),
        });
    }
    let process = owned(pi.hProcess);
    let thread = owned(pi.hThread);

    if let Some(job_handle) = &job {
        if unsafe { AssignProcessToJobObject(raw(job_handle), raw(&process)) } == 0 {
            let err = win32_err("AssignProcessToJobObject");
            unsafe { TerminateProcess(raw(&process), 1) };
            return Err(err);
        }
    }
    if unsafe { ResumeThread(raw(&thread)) } == u32::MAX {
        let err = win32_err("ResumeThread");
        unsafe { TerminateProcess(raw(&process), 1) };
        return Err(err);
    }
    drop(thread);
    drop(attrs);
    // conhost holds its own references to these ends now.
    drop(in_read);
    drop(out_write);

    let pty = Pty {
        console: Mutex::new(pty_console.release()),
        process,
        job,
        pid: pi.dwProcessId,
    };
    let reader = File::from(out_read);
    let writer = File::from(in_write);
    Ok((pty, reader, writer))
}

struct ConsoleGuard(Option<HPCON>);

impl ConsoleGuard {
    fn release(mut self) -> Option<HPCON> {
        self.0.take()
    }
}

impl Drop for ConsoleGuard {
    fn drop(&mut self) {
        if let Some(h) = self.0.take() {
            unsafe { ClosePseudoConsole(h) };
        }
    }
}

impl Pty {
    /// Process ID of the direct child (the shell).
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Resize the pseudo console. No-op once the console has been closed.
    pub fn resize(&self, size: PtySize) -> Result<()> {
        let size = PtySize::new(size.cols, size.rows);
        let guard = self.console.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(hpc) = *guard {
            let hr = unsafe {
                ResizePseudoConsole(
                    hpc,
                    COORD {
                        X: size.cols as i16,
                        Y: size.rows as i16,
                    },
                )
            };
            if hr < 0 {
                return Err(PtyError::Win32 {
                    op: "ResizePseudoConsole",
                    source: std::io::Error::from_raw_os_error(hr),
                });
            }
        }
        Ok(())
    }

    /// Close the pseudo console. Attached clients receive `CTRL_CLOSE_EVENT`
    /// and the output pipe reaches EOF once remaining output is drained.
    ///
    /// Must not be called from the thread that reads the output pipe.
    pub fn close_console(&self) {
        let hpc = self
            .console
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(hpc) = hpc {
            unsafe { ClosePseudoConsole(hpc) };
        }
    }

    /// Forcefully terminate the child and its entire process tree.
    pub fn kill(&self) -> Result<()> {
        let ok = match &self.job {
            Some(job) => unsafe { TerminateJobObject(raw(job), 1) },
            None => unsafe { TerminateProcess(raw(&self.process), 1) },
        };
        if ok == 0 {
            // Already-exited processes report ACCESS_DENIED; treat as success.
            if self.try_wait().is_some() {
                return Ok(());
            }
            return Err(win32_err("TerminateJobObject"));
        }
        Ok(())
    }

    /// Exit code if the child has exited, without blocking.
    pub fn try_wait(&self) -> Option<u32> {
        self.wait_timeout(Duration::ZERO)
    }

    /// Wait up to `timeout` for the child to exit.
    pub fn wait_timeout(&self, timeout: Duration) -> Option<u32> {
        let ms = u32::try_from(timeout.as_millis()).unwrap_or(INFINITE - 1);
        if unsafe { WaitForSingleObject(raw(&self.process), ms) } == WAIT_OBJECT_0 {
            self.exit_code()
        } else {
            None
        }
    }

    /// Block until the child exits and return its exit code.
    pub fn wait(&self) -> Result<u32> {
        if unsafe { WaitForSingleObject(raw(&self.process), INFINITE) } != WAIT_OBJECT_0 {
            return Err(win32_err("WaitForSingleObject"));
        }
        self.exit_code()
            .ok_or_else(|| win32_err("GetExitCodeProcess"))
    }

    fn exit_code(&self) -> Option<u32> {
        let mut code: u32 = 0;
        if unsafe { GetExitCodeProcess(raw(&self.process), &mut code) } == 0 {
            return None;
        }
        (code != STILL_ACTIVE).then_some(code)
    }
}

impl Drop for Pty {
    fn drop(&mut self) {
        self.close_console();
        // Dropping the job handle (KILL_ON_JOB_CLOSE) kills any survivors.
    }
}
