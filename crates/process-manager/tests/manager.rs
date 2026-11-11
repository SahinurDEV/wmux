#![cfg(windows)]

use std::sync::mpsc;
use std::time::Duration;

use wmux_process_manager::{CommandSpec, ProcessError, ProcessManager, PtySize, SessionEvent};

fn sink() -> (wmux_process_manager::EventSink, mpsc::Receiver<SessionEvent>) {
    let (tx, rx) = mpsc::channel();
    let tx = std::sync::Mutex::new(tx);
    (
        Box::new(move |ev| {
            let _ = tx.lock().unwrap().send(ev);
        }),
        rx,
    )
}

/// Collect output until the exit event; returns (text, exit code).
fn drain(rx: &mpsc::Receiver<SessionEvent>) -> (String, Option<u32>) {
    let mut out = Vec::new();
    loop {
        match rx.recv_timeout(Duration::from_secs(20)).expect("event") {
            SessionEvent::Output(b) => out.extend(b),
            SessionEvent::Exited { code } => return (String::from_utf8_lossy(&out).into(), code),
        }
    }
}

#[test]
fn interactive_session_roundtrip_and_exit_event_after_output() {
    let pm = ProcessManager::new();
    let (s, rx) = sink();
    let info = pm
        .spawn("t1", &CommandSpec::new("cmd.exe").args(["/d", "/q"]), PtySize::new(80, 24), s)
        .unwrap();
    assert!(info.running && info.pid > 0);
    pm.write("t1", b"echo pm-roundtrip\r".to_vec()).unwrap();
    pm.write("t1", b"exit 9\r".to_vec()).unwrap();
    let (text, code) = drain(&rx);
    assert!(text.contains("pm-roundtrip"), "{text:?}");
    assert_eq!(code, Some(9));
    let info = pm.info("t1").unwrap();
    assert!(!info.running);
    assert_eq!(info.exit_code, Some(9));
    assert!(matches!(pm.write("t1", b"x".to_vec()), Err(ProcessError::Exited(_))));
}

#[test]
fn duplicate_running_id_is_rejected_but_restart_after_exit_works() {
    let pm = ProcessManager::new();
    let (s1, rx1) = sink();
    pm.spawn("dup", &CommandSpec::new("cmd.exe").args(["/d", "/q"]), PtySize::default(), s1)
        .unwrap();
    let (s2, _rx2) = sink();
    let err = pm
        .spawn("dup", &CommandSpec::new("cmd.exe"), PtySize::default(), s2)
        .unwrap_err();
    assert!(matches!(err, ProcessError::AlreadyRunning(_)));

    pm.kill("dup").unwrap();
    let (_, code) = drain(&rx1);
    assert_eq!(code, Some(1));

    // Restart with the same id.
    let (s3, rx3) = sink();
    pm.spawn(
        "dup",
        &CommandSpec::new("cmd.exe").args(["/d", "/c", "echo again"]),
        PtySize::default(),
        s3,
    )
    .unwrap();
    let (text, code) = drain(&rx3);
    assert!(text.contains("again"));
    assert_eq!(code, Some(0));
}

#[test]
fn close_unregisters_and_terminates() {
    let pm = ProcessManager::new();
    let (s, rx) = sink();
    pm.spawn(
        "c1",
        &CommandSpec::new("cmd.exe").args(["/d", "/c", "ping -n 60 127.0.0.1 > nul"]),
        PtySize::default(),
        s,
    )
    .unwrap();
    pm.close("c1").unwrap();
    assert!(pm.info("c1").is_none());
    let (_, code) = drain(&rx);
    assert!(code.is_some());
}

#[test]
fn large_output_is_streamed_completely() {
    let pm = ProcessManager::new();
    let (s, rx) = sink();
    // ~5000 lines through the pseudo console.
    pm.spawn(
        "big",
        &CommandSpec::new("powershell.exe").args([
            "-NoLogo",
            "-NoProfile",
            "-Command",
            "1..5000 | ForEach-Object { \"line-$_\" }",
        ]),
        PtySize::new(120, 40),
        s,
    )
    .unwrap();
    let (text, code) = drain(&rx);
    assert_eq!(code, Some(0));
    assert!(text.contains("line-1\r"), "first line missing");
    assert!(text.contains("line-5000"), "last line missing");
}

#[test]
fn unknown_session_errors() {
    let pm = ProcessManager::new();
    assert!(matches!(pm.write("nope", vec![]), Err(ProcessError::NotFound(_))));
    assert!(matches!(pm.resize("nope", PtySize::default()), Err(ProcessError::NotFound(_))));
    assert!(matches!(pm.kill("nope"), Err(ProcessError::NotFound(_))));
}
