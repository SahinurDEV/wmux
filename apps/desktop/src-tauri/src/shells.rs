//! Shell profile detection and resolution.
//!
//! Built-in profiles are detected on every call (cheap filesystem/registry
//! probes) so newly installed shells show up without restarting Wmux.
//! Custom profiles come from the `terminal.customProfiles` setting.

use std::path::{Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ShellKind {
    Pwsh,
    WindowsPowershell,
    Cmd,
    Wsl,
    GitBash,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellProfile {
    pub id: String,
    pub name: String,
    pub kind: ShellKind,
    pub program: String,
    pub args: Vec<String>,
}

/// Shape of entries in the `terminal.customProfiles` setting.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomProfile {
    pub id: String,
    pub name: String,
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
}

fn system_root() -> PathBuf {
    std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
}

fn exists(p: &Path) -> bool {
    // symlink_metadata also succeeds for App Execution Aliases (reparse points
    // in WindowsApps), which `is_file()` reports as false.
    std::fs::symlink_metadata(p).is_ok()
}

/// Search `PATH` for an executable name.
pub fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| exists(candidate))
}

fn find_pwsh() -> Option<PathBuf> {
    if let Some(p) = which("pwsh.exe") {
        return Some(p);
    }
    let pf = std::env::var_os("ProgramFiles").map(PathBuf::from)?;
    ["PowerShell\\7\\pwsh.exe", "PowerShell\\7-preview\\pwsh.exe"]
        .iter()
        .map(|rel| pf.join(rel))
        .find(|p| exists(p))
}

fn find_git_bash() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(git) = which("git.exe") {
        // ...\Git\cmd\git.exe -> ...\Git\bin\bash.exe
        if let Some(root) = git.parent().and_then(Path::parent) {
            candidates.push(root.join("bin").join("bash.exe"));
        }
    }
    for var in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Some(base) = std::env::var_os(var).map(PathBuf::from) {
            candidates.push(base.join(r"Git\bin\bash.exe"));
            candidates.push(base.join(r"Programs\Git\bin\bash.exe"));
        }
    }
    candidates.into_iter().find(|p| exists(p))
}

#[cfg(windows)]
fn wsl_distributions() -> Vec<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let Ok(lxss) = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Lxss")
    else {
        return Vec::new();
    };
    lxss.enum_keys()
        .filter_map(Result::ok)
        .filter_map(|k| lxss.open_subkey(k).ok())
        .filter_map(|k| k.get_value::<String, _>("DistributionName").ok())
        .filter(|name| !name.starts_with("docker-desktop"))
        .collect()
}

#[cfg(not(windows))]
fn wsl_distributions() -> Vec<String> {
    Vec::new()
}

/// Detect built-in shells plus validated custom profiles, in preference order.
pub fn detect(custom: &[CustomProfile]) -> Vec<ShellProfile> {
    let mut out = Vec::new();
    if let Some(p) = find_pwsh() {
        out.push(ShellProfile {
            id: "pwsh".into(),
            name: "PowerShell 7".into(),
            kind: ShellKind::Pwsh,
            program: p.to_string_lossy().into_owned(),
            args: vec!["-NoLogo".into()],
        });
    }
    let winps = system_root().join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    if exists(&winps) {
        out.push(ShellProfile {
            id: "powershell".into(),
            name: "Windows PowerShell".into(),
            kind: ShellKind::WindowsPowershell,
            program: winps.to_string_lossy().into_owned(),
            args: vec!["-NoLogo".into()],
        });
    }
    let cmd = std::env::var_os("ComSpec")
        .map(PathBuf::from)
        .filter(|p| exists(p))
        .unwrap_or_else(|| system_root().join(r"System32\cmd.exe"));
    if exists(&cmd) {
        out.push(ShellProfile {
            id: "cmd".into(),
            name: "Command Prompt".into(),
            kind: ShellKind::Cmd,
            program: cmd.to_string_lossy().into_owned(),
            args: vec![],
        });
    }
    let wsl = system_root().join(r"System32\wsl.exe");
    if exists(&wsl) {
        for distro in wsl_distributions() {
            out.push(ShellProfile {
                id: format!("wsl:{distro}"),
                name: format!("WSL: {distro}"),
                kind: ShellKind::Wsl,
                program: wsl.to_string_lossy().into_owned(),
                args: vec!["-d".into(), distro],
            });
        }
    }
    if let Some(bash) = find_git_bash() {
        out.push(ShellProfile {
            id: "gitbash".into(),
            name: "Git Bash".into(),
            kind: ShellKind::GitBash,
            program: bash.to_string_lossy().into_owned(),
            args: vec!["--login".into(), "-i".into()],
        });
    }
    for c in custom {
        if c.id.trim().is_empty() || c.program.trim().is_empty() {
            continue;
        }
        out.push(ShellProfile {
            id: format!("custom:{}", c.id),
            name: c.name.clone(),
            kind: ShellKind::Custom,
            program: c.program.clone(),
            args: c.args.clone(),
        });
    }
    out
}

/// PowerShell prompt wrapper that reports the current directory to the
/// terminal with the Windows Terminal `OSC 9;9` sequence. It wraps whatever
/// prompt the user's profile defined, so their prompt stays intact.
const PS_INTEGRATION: &str = r#"
if (-not $global:__wmuxIntegrated) {
  $global:__wmuxIntegrated = $true
  $global:__wmuxOriginalPrompt = $function:prompt
  function global:prompt {
    $loc = $executionContext.SessionState.Path.CurrentLocation
    $esc = [char]27
    $osc = ''
    if ($loc.Provider.Name -eq 'FileSystem') { $osc = "$esc]9;9;`"$($loc.ProviderPath)`"$esc\" }
    $osc + (& $global:__wmuxOriginalPrompt)
  }
}
"#;

fn encode_ps_command(script: &str) -> String {
    let utf16: Vec<u8> = script
        .encode_utf16()
        .flat_map(|u| u.to_le_bytes())
        .collect();
    base64::engine::general_purpose::STANDARD.encode(utf16)
}

/// Final launch parameters for a profile.
pub struct Launch {
    pub program: String,
    pub args: Vec<String>,
    pub extra_env: Vec<(String, String)>,
}

/// Apply optional shell integration (current-directory reporting).
pub fn launch_for(profile: &ShellProfile, integration: bool) -> Launch {
    let mut args = profile.args.clone();
    let mut extra_env = Vec::new();
    if integration {
        match profile.kind {
            ShellKind::Pwsh | ShellKind::WindowsPowershell => {
                args.push("-NoExit".into());
                args.push("-EncodedCommand".into());
                args.push(encode_ps_command(PS_INTEGRATION));
            }
            ShellKind::Cmd => {
                // Respect a user-defined PROMPT.
                if std::env::var_os("PROMPT").is_none() {
                    extra_env.push(("PROMPT".into(), "$e]9;9;$P$e\\$P$G".into()));
                }
            }
            _ => {}
        }
    }
    Launch {
        program: profile.program.clone(),
        args,
        extra_env,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoded_command_is_utf16le_base64() {
        let enc = encode_ps_command("ab");
        assert_eq!(enc, "YQBiAA==");
    }

    #[test]
    fn custom_profiles_are_validated() {
        let profiles = detect(&[
            CustomProfile {
                id: "ok".into(),
                name: "Ok".into(),
                program: "foo.exe".into(),
                args: vec![],
            },
            CustomProfile {
                id: "".into(),
                name: "Bad".into(),
                program: "foo.exe".into(),
                args: vec![],
            },
        ]);
        let custom: Vec<_> = profiles
            .iter()
            .filter(|p| p.kind == ShellKind::Custom)
            .collect();
        assert_eq!(custom.len(), 1);
        assert_eq!(custom[0].id, "custom:ok");
    }

    #[test]
    fn powershell_integration_adds_encoded_command() {
        let p = ShellProfile {
            id: "powershell".into(),
            name: "x".into(),
            kind: ShellKind::WindowsPowershell,
            program: "powershell.exe".into(),
            args: vec!["-NoLogo".into()],
        };
        let l = launch_for(&p, true);
        assert_eq!(l.args[0], "-NoLogo");
        assert!(l.args.contains(&"-EncodedCommand".to_string()));
        let plain = launch_for(&p, false);
        assert_eq!(plain.args, vec!["-NoLogo".to_string()]);
    }
}
