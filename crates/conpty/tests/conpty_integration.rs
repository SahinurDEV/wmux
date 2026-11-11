//! Integration tests against the real Windows ConPTY API.
#![cfg(windows)]

use std::io::{Read, Write};
use std::thread;
use std::time::{Duration, Instant};

use wmux_conpty::{spawn, CommandSpec, PtySize};

/// Drain the reader on a background thread, returning everything read
/// once the pipe hits EOF.
fn collect(mut reader: std::fs::File) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut out = Vec::new();
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => out.extend_from_slice(&buf[..n]),
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    })
}

/// Strip VT escape sequences so assertions can look at plain text.
fn strip_vt(s: &str) -> String {
    let mut out = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.peek() {
                Some('[') => {
                    chars.next();
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    chars.next();
                    while let Some(c) = chars.next() {
                        if c == '\x07' {
                            break;
                        }
                        if c == '\x1b' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {
                    chars.next();
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[test]
fn cmd_echo_produces_output_and_exit_code() {
    let spec = CommandSpec::new("cmd.exe").args(["/d", "/c", "echo wmux-conpty-ok && exit /b 7"]);
    let (pty, reader, _writer) = spawn(&spec, PtySize::new(80, 25)).expect("spawn");
    let out = collect(reader);
    let code = pty.wait().expect("wait");
    pty.close_console();
    let text = strip_vt(&out.join().unwrap());
    assert!(text.contains("wmux-conpty-ok"), "output was: {text:?}");
    assert_eq!(code, 7);
}

#[test]
fn powershell_runs_real_commands() {
    let spec = CommandSpec::new("powershell.exe").args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Write-Output ('sum=' + (40 + 2)); exit 3",
    ]);
    let (pty, reader, _writer) = spawn(&spec, PtySize::new(100, 30)).expect("spawn");
    let out = collect(reader);
    let code = pty.wait().expect("wait");
    pty.close_console();
    let text = strip_vt(&out.join().unwrap());
    assert!(text.contains("sum=42"), "output was: {text:?}");
    assert_eq!(code, 3);
}

#[test]
fn interactive_input_reaches_the_shell() {
    let spec = CommandSpec::new("cmd.exe").args(["/d", "/q"]);
    let (pty, reader, mut writer) = spawn(&spec, PtySize::new(80, 25)).expect("spawn");
    let out = collect(reader);
    writer.write_all(b"echo typed-%COMPUTERNAME:~0,0%input\r").unwrap();
    writer.write_all(b"exit 5\r").unwrap();
    let code = pty.wait().expect("wait");
    pty.close_console();
    let text = strip_vt(&out.join().unwrap());
    assert!(text.contains("typed-input"), "output was: {text:?}");
    assert_eq!(code, 5);
}

#[test]
fn environment_and_cwd_are_applied() {
    let dir = std::env::temp_dir();
    let spec = CommandSpec::new("cmd.exe")
        .args(["/d", "/c", "echo [%WMUX_TEST_VAR%] & cd"])
        .env("WMUX_TEST_VAR", "hello-env")
        .cwd(&dir);
    let (pty, reader, _writer) = spawn(&spec, PtySize::default()).expect("spawn");
    let out = collect(reader);
    pty.wait().unwrap();
    pty.close_console();
    let text = strip_vt(&out.join().unwrap());
    assert!(text.contains("[hello-env]"), "output was: {text:?}");
    let dir_str = dir.to_string_lossy().trim_end_matches('\\').to_lowercase();
    assert!(
        text.to_lowercase().replace(['\r', '\n'], "").contains(&dir_str),
        "cwd {dir_str:?} not in {text:?}"
    );
}

#[test]
fn resize_is_reported_to_the_child() {
    let spec = CommandSpec::new("powershell.exe").args([
        "-NoLogo",
        "-NoProfile",
        "-Command",
        "Start-Sleep -Milliseconds 700; $s=$Host.UI.RawUI.WindowSize; Write-Output \"size=$($s.Width)x$($s.Height)\"",
    ]);
    let (pty, reader, _writer) = spawn(&spec, PtySize::new(80, 25)).expect("spawn");
    let out = collect(reader);
    pty.resize(PtySize::new(132, 43)).expect("resize");
    pty.wait().unwrap();
    pty.close_console();
    let text = strip_vt(&out.join().unwrap());
    assert!(text.contains("size=132x43"), "output was: {text:?}");
}

#[test]
fn kill_terminates_the_process_tree() {
    // cmd starts a long-running child; killing the job must end both.
    let spec = CommandSpec::new("cmd.exe").args(["/d", "/c", "ping -n 60 127.0.0.1 > nul"]);
    let (pty, reader, _writer) = spawn(&spec, PtySize::default()).expect("spawn");
    let out = collect(reader);
    thread::sleep(Duration::from_millis(300));
    assert!(pty.try_wait().is_none(), "process should still be running");
    let started = Instant::now();
    pty.kill().expect("kill");
    let code = pty.wait_timeout(Duration::from_secs(5)).expect("exited after kill");
    assert_eq!(code, 1);
    assert!(started.elapsed() < Duration::from_secs(5));
    pty.close_console();
    out.join().unwrap();
}

#[test]
fn invalid_cwd_is_rejected_with_clear_error() {
    let spec = CommandSpec::new("cmd.exe").cwd(r"Z:\definitely\not\here\wmux");
    let err = spawn(&spec, PtySize::default()).err().expect("should fail");
    assert!(err.to_string().contains("working directory"), "{err}");
}

#[test]
fn missing_program_reports_error() {
    let spec = CommandSpec::new("wmux-no-such-program-xyz.exe");
    let err = spawn(&spec, PtySize::default()).err().expect("should fail");
    assert!(err.to_string().contains("CreateProcessW"), "{err}");
}
