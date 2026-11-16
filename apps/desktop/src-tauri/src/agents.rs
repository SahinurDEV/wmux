//! Detects coding agents (Claude Code, Codex) running inside terminals and
//! records their native session ids, so the session can be resumed after
//! Wmux — or the whole PC — restarts.
//!
//! Nothing is injected into the agents. A background thread walks the process
//! tree below each terminal's shell every few seconds and reads what the
//! agents already write about themselves:
//!
//! * Claude Code writes `~/.claude/sessions/<pid>.json` (`sessionId`, `cwd`)
//!   for every running instance and removes it on exit.
//! * Codex appends to `~/.codex/sessions/**/rollout-<time>-<uuid>.jsonl`; the
//!   file touched since the `codex.exe` process started is its session.
//!   This is a best-effort match when several Codex instances run at once.
//!
//! Agents running inside WSL are not visible to this scan.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use wmux_process_manager::ProcessManager;
use wmux_session_manager::{is_safe_session_id, AgentRecord, Store};

const SCAN_INTERVAL: Duration = Duration::from_secs(4);
/// Consecutive scans without an agent before its record is forgotten. The
/// grace period keeps the record when the OS kills the agent moments before
/// Wmux itself during shutdown, and while a resumed agent is still starting.
const MISSES_BEFORE_FORGET: u32 = 3;
const CODEX_CACHE_TTL: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proc {
    pub pid: u32,
    pub parent: u32,
    pub exe: String,
}

/// All processes below `root`, nearest first (breadth-first).
pub fn descendants(root: u32, procs: &[Proc]) -> Vec<&Proc> {
    let mut children: HashMap<u32, Vec<&Proc>> = HashMap::new();
    for p in procs {
        children.entry(p.parent).or_default().push(p);
    }
    let mut seen = HashSet::from([root]);
    let mut queue = std::collections::VecDeque::from([root]);
    let mut out = Vec::new();
    while let Some(pid) = queue.pop_front() {
        for child in children.get(&pid).into_iter().flatten() {
            if child.pid != 0 && seen.insert(child.pid) {
                out.push(*child);
                queue.push_back(child.pid);
            }
        }
    }
    out
}

/// Parse Claude Code's `sessions/<pid>.json`.
pub fn parse_claude_session(json: &str, pid: u32) -> Option<AgentRecord> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    if v.get("pid").and_then(|p| p.as_u64()) != Some(u64::from(pid)) {
        return None;
    }
    // Background/SDK instances are not something a person resumes in a pane.
    if let Some(kind) = v.get("kind").and_then(|k| k.as_str()) {
        if kind != "interactive" {
            return None;
        }
    }
    let session_id = v.get("sessionId")?.as_str()?;
    if !is_safe_session_id(session_id) {
        return None;
    }
    Some(AgentRecord {
        kind: "claude".into(),
        session_id: session_id.into(),
        cwd: v.get("cwd").and_then(|c| c.as_str()).map(str::to_owned),
    })
}

/// `rollout-2026-05-10T10-32-53-<uuid>.jsonl` -> `<uuid>`.
pub fn codex_session_id(file_name: &str) -> Option<String> {
    let stem = file_name.strip_prefix("rollout-")?.strip_suffix(".jsonl")?;
    let id = stem.get(stem.len().checked_sub(36)?..)?;
    let shaped = id.bytes().enumerate().all(|(i, b)| match i {
        8 | 13 | 18 | 23 => b == b'-',
        _ => b.is_ascii_hexdigit(),
    });
    shaped.then(|| id.to_string())
}

/// The working directory from a rollout file's first (`session_meta`) line.
pub fn codex_meta_cwd(first_line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(first_line).ok()?;
    v.get("payload")?.get("cwd")?.as_str().map(str::to_owned)
}

fn read_first_line(path: &Path) -> Option<String> {
    use std::io::{BufRead, BufReader, Read};
    let file = std::fs::File::open(path).ok()?;
    let mut line = String::new();
    // The first line embeds the system prompt, so it can be large; cap it.
    BufReader::new(file.take(4 * 1024 * 1024))
        .read_line(&mut line)
        .ok()?;
    Some(line)
}

/// Rollout files modified at or after `since`, newest first.
fn recent_rollouts(
    dir: &Path,
    since: SystemTime,
    depth: u32,
    out: &mut Vec<(SystemTime, PathBuf)>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let path = entry.path();
        if meta.is_dir() {
            if depth > 0 {
                recent_rollouts(&path, since, depth - 1, out);
            }
        } else if let Ok(modified) = meta.modified() {
            let name = entry.file_name();
            if modified >= since && codex_session_id(&name.to_string_lossy()).is_some() {
                out.push((modified, path));
            }
        }
    }
}

#[cfg(windows)]
mod win {
    use super::Proc;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    pub fn snapshot() -> Vec<Proc> {
        let mut out = Vec::new();
        // SAFETY: plain Win32 calls; the entry struct is zeroed with its size
        // set as the API requires, and the handle is closed before returning.
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return out;
            }
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            if Process32FirstW(snap, &mut entry) != 0 {
                loop {
                    let len = entry
                        .szExeFile
                        .iter()
                        .position(|&c| c == 0)
                        .unwrap_or(entry.szExeFile.len());
                    out.push(Proc {
                        pid: entry.th32ProcessID,
                        parent: entry.th32ParentProcessID,
                        exe: String::from_utf16_lossy(&entry.szExeFile[..len]),
                    });
                    if Process32NextW(snap, &mut entry) == 0 {
                        break;
                    }
                }
            }
            CloseHandle(snap);
        }
        out
    }

    pub fn creation_time(pid: u32) -> Option<SystemTime> {
        // SAFETY: the handle is checked for null and closed; the FILETIME
        // out-parameters are valid for the duration of the call.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return None;
            }
            let zero = FILETIME {
                dwLowDateTime: 0,
                dwHighDateTime: 0,
            };
            let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
            let ok = GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user);
            CloseHandle(handle);
            if ok == 0 {
                return None;
            }
            // FILETIME: 100 ns ticks since 1601-01-01.
            let ticks =
                (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
            let unix_ticks = ticks.checked_sub(116_444_736_000_000_000)?;
            Some(UNIX_EPOCH + Duration::from_nanos(unix_ticks.saturating_mul(100)))
        }
    }
}

#[cfg(not(windows))]
mod win {
    use super::Proc;
    use std::time::SystemTime;
    pub fn snapshot() -> Vec<Proc> {
        Vec::new()
    }
    pub fn creation_time(_pid: u32) -> Option<SystemTime> {
        None
    }
}

struct Detector {
    claude_dir: PathBuf,
    codex_dir: PathBuf,
    /// codex pid -> (resolved at, result)
    codex_cache: HashMap<u32, (Instant, Option<AgentRecord>)>,
}

impl Detector {
    fn new(home: &Path) -> Self {
        let env_dir = |var: &str, default: &str| {
            std::env::var_os(var)
                .map(PathBuf::from)
                .filter(|p| p.is_absolute())
                .unwrap_or_else(|| home.join(default))
        };
        Self {
            claude_dir: env_dir("CLAUDE_CONFIG_DIR", ".claude"),
            codex_dir: env_dir("CODEX_HOME", ".codex"),
            codex_cache: HashMap::new(),
        }
    }

    /// The agent running below `shell_pid`, if any. `claimed` holds Codex
    /// session ids already assigned to other terminals in this scan.
    fn detect(
        &mut self,
        shell_pid: u32,
        procs: &[Proc],
        claimed: &mut HashSet<String>,
    ) -> Option<AgentRecord> {
        let shell_started = win::creation_time(shell_pid);
        // A PID can be reused; a real descendant never predates the shell.
        let is_real_child = |pid: u32| match (shell_started, win::creation_time(pid)) {
            (Some(shell), Some(child)) => child >= shell,
            _ => true,
        };
        let tree = descendants(shell_pid, procs);

        for p in &tree {
            let path = self
                .claude_dir
                .join("sessions")
                .join(format!("{}.json", p.pid));
            let Ok(json) = std::fs::read_to_string(&path) else {
                continue;
            };
            if let Some(agent) = parse_claude_session(&json, p.pid) {
                if is_real_child(p.pid) {
                    return Some(agent);
                }
            }
        }

        let codex = tree
            .iter()
            .find(|p| p.exe.eq_ignore_ascii_case("codex.exe") && is_real_child(p.pid))?;
        let agent = self.resolve_codex(codex.pid, claimed)?;
        claimed.insert(agent.session_id.clone());
        Some(agent)
    }

    fn resolve_codex(&mut self, pid: u32, claimed: &HashSet<String>) -> Option<AgentRecord> {
        if let Some((at, cached)) = self.codex_cache.get(&pid) {
            let reusable = match cached {
                Some(a) => !claimed.contains(&a.session_id),
                None => true,
            };
            if reusable && at.elapsed() < CODEX_CACHE_TTL {
                return cached.clone();
            }
        }
        let started = win::creation_time(pid)?;
        let since = started
            .checked_sub(Duration::from_secs(2))
            .unwrap_or(started);
        let mut files = Vec::new();
        recent_rollouts(&self.codex_dir.join("sessions"), since, 4, &mut files);
        files.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
        let found = files.into_iter().find_map(|(_, path)| {
            let id = codex_session_id(&path.file_name()?.to_string_lossy())?;
            if claimed.contains(&id) {
                return None;
            }
            Some(AgentRecord {
                kind: "codex".into(),
                session_id: id,
                cwd: read_first_line(&path).and_then(|l| codex_meta_cwd(&l)),
            })
        });
        self.codex_cache
            .insert(pid, (Instant::now(), found.clone()));
        found
    }
}

#[derive(Default)]
struct Tracked {
    last: Option<AgentRecord>,
    misses: u32,
    forgotten: bool,
}

/// Start the background scan. Set the returned flag to stop it (done before
/// terminals are killed on exit, so their agents are not seen as "gone").
pub fn start_scanner(
    processes: Arc<ProcessManager>,
    store: Arc<Mutex<Store>>,
    home: PathBuf,
) -> Arc<AtomicBool> {
    let stop = Arc::new(AtomicBool::new(false));
    let stop_flag = Arc::clone(&stop);
    let spawned = std::thread::Builder::new()
        .name("wmux-agent-scan".into())
        .spawn(move || {
            let mut detector = Detector::new(&home);
            let mut tracked: HashMap<String, Tracked> = HashMap::new();
            loop {
                let wake = Instant::now() + SCAN_INTERVAL;
                while Instant::now() < wake {
                    if stop_flag.load(Ordering::Relaxed) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(200));
                }
                let sessions: Vec<_> = processes.list().into_iter().filter(|s| s.running).collect();
                tracked.retain(|id, _| sessions.iter().any(|s| &s.id == id));
                if sessions.is_empty() {
                    continue;
                }
                let procs = win::snapshot();
                detector
                    .codex_cache
                    .retain(|pid, _| procs.iter().any(|p| p.pid == *pid));
                let mut claimed = HashSet::new();
                for session in &sessions {
                    let found = detector.detect(session.pid, &procs, &mut claimed);
                    let t = tracked.entry(session.id.clone()).or_default();
                    let write = match found {
                        Some(agent) => {
                            t.misses = 0;
                            t.forgotten = false;
                            (t.last.as_ref() != Some(&agent)).then(|| {
                                t.last = Some(agent.clone());
                                Some(agent)
                            })
                        }
                        None => {
                            t.misses += 1;
                            (t.misses >= MISSES_BEFORE_FORGET && !t.forgotten).then(|| {
                                t.forgotten = true;
                                t.last = None;
                                None
                            })
                        }
                    };
                    let Some(agent) = write else { continue };
                    if stop_flag.load(Ordering::Relaxed) {
                        return;
                    }
                    let Ok(store) = store.lock() else { return };
                    if let Err(e) = store.set_agent(&session.id, agent.as_ref()) {
                        log::warn!("failed to record agent session: {e}");
                    } else if let Some(a) = &agent {
                        log::info!(
                            "surface {} runs {} session {}",
                            session.id,
                            a.kind,
                            a.session_id
                        );
                    }
                }
            }
        });
    if let Err(e) = spawned {
        log::warn!("agent session scan could not start: {e}");
    }
    stop
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(pid: u32, parent: u32, exe: &str) -> Proc {
        Proc {
            pid,
            parent,
            exe: exe.into(),
        }
    }

    #[test]
    fn descendants_are_breadth_first_and_survive_cycles() {
        let procs = vec![
            p(10, 1, "pwsh.exe"),
            p(20, 10, "node.exe"),
            p(30, 20, "codex.exe"),
            p(40, 10, "git.exe"),
            p(50, 99, "unrelated.exe"),
            // A reused PID can make the parent links loop.
            p(10, 30, "pwsh.exe"),
        ];
        let pids: Vec<u32> = descendants(10, &procs).iter().map(|p| p.pid).collect();
        assert_eq!(pids, vec![20, 40, 30]);
    }

    #[test]
    fn claude_session_file_is_parsed_and_validated() {
        let json = r#"{"pid":16056,"sessionId":"e447e639-4a2b-43b7-9a58-3839af532169",
            "cwd":"C:\\Users\\me\\proj","kind":"interactive"}"#;
        let agent = parse_claude_session(json, 16056).unwrap();
        assert_eq!(agent.kind, "claude");
        assert_eq!(agent.session_id, "e447e639-4a2b-43b7-9a58-3839af532169");
        assert_eq!(agent.cwd.as_deref(), Some(r"C:\Users\me\proj"));

        assert!(parse_claude_session(json, 1).is_none(), "pid must match");
        let background = json.replace("interactive", "sdk");
        assert!(parse_claude_session(&background, 16056).is_none());
        let hostile = r#"{"pid":5,"sessionId":"abcdefgh; calc.exe"}"#;
        assert!(parse_claude_session(hostile, 5).is_none());
        assert!(parse_claude_session("not json", 5).is_none());
    }

    #[test]
    fn codex_rollout_names_yield_the_session_id() {
        assert_eq!(
            codex_session_id(
                "rollout-2026-05-10T10-32-53-019e1028-dcd9-7533-ba4d-4a6f563444c2.jsonl"
            )
            .as_deref(),
            Some("019e1028-dcd9-7533-ba4d-4a6f563444c2")
        );
        assert!(codex_session_id("rollout-2026-05-10T10-32-53.jsonl").is_none());
        assert!(codex_session_id("notes.jsonl").is_none());
        assert!(codex_session_id("rollout-x-019e1028-dcd9-7533-ba4d-4a6f563444c2.txt").is_none());
        assert_eq!(
            codex_meta_cwd(r#"{"type":"session_meta","payload":{"id":"x","cwd":"C:\\src"}}"#)
                .as_deref(),
            Some(r"C:\src")
        );
    }

    #[test]
    fn codex_session_is_the_rollout_touched_since_the_process_started() {
        let dir = tempfile::tempdir().unwrap();
        let day = dir
            .path()
            .join("sessions")
            .join("2026")
            .join("11")
            .join("16");
        std::fs::create_dir_all(&day).unwrap();
        let name = "rollout-2026-11-16T10-00-00-019e1028-dcd9-7533-ba4d-4a6f563444c2.jsonl";
        std::fs::write(day.join(name), "{\"payload\":{\"cwd\":\"C:\\\\src\"}}\n").unwrap();

        let mut found = Vec::new();
        let earlier = SystemTime::now() - Duration::from_secs(60);
        recent_rollouts(&dir.path().join("sessions"), earlier, 4, &mut found);
        assert_eq!(found.len(), 1);
        assert_eq!(
            read_first_line(&found[0].1)
                .and_then(|l| codex_meta_cwd(&l))
                .as_deref(),
            Some(r"C:\src")
        );

        let mut none = Vec::new();
        let later = SystemTime::now() + Duration::from_secs(60);
        recent_rollouts(&dir.path().join("sessions"), later, 4, &mut none);
        assert!(none.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn process_snapshot_contains_this_process() {
        let me = std::process::id();
        let procs = win::snapshot();
        assert!(procs.iter().any(|p| p.pid == me));
        let started = win::creation_time(me).expect("own creation time");
        assert!(started <= SystemTime::now());
    }
}
