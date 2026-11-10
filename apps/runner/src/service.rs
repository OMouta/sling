//! `sling-runner service install|uninstall|status`. The Runner
//! runs as the logged-in user so it can use that user's agent logins and git
//! credentials: a launchd LaunchAgent on macOS, a systemd user unit on Linux,
//! and a logon scheduled task on Windows.

use std::path::PathBuf;

use anyhow::{Context, Result, bail};

use crate::config::Paths;

pub const LABEL: &str = "dev.sling.runner";
/// Exit code for "this Runner was revoked". Service managers must not restart.
pub const EXIT_REVOKED: i32 = 78;
/// Set in the service definition so the Runner knows to log to a file.
pub const SERVICE_ENV: &str = "SLING_RUNNER_SERVICE";
/// The Windows logon task's name.
const TASK: &str = "SlingRunner";

fn exe() -> Result<PathBuf> {
    std::env::current_exe()?
        .canonicalize()
        .context("finding the sling-runner binary")
}

/// PATH at install time. Service managers start with a bare PATH, which would
/// hide codex, claude, git, and gh.
fn path_env() -> String {
    std::env::var("PATH").unwrap_or_default()
}

fn home_env() -> Option<String> {
    std::env::var("SLING_RUNNER_HOME").ok()
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub fn launchd_plist(exe: &str, path: &str, home: Option<&str>) -> String {
    let home_entry = home
        .map(|h| {
            format!(
                "\n    <key>SLING_RUNNER_HOME</key><string>{}</string>",
                xml_escape(h)
            )
        })
        .unwrap_or_default();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>{exe}</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>{path}</string>
    <key>{SERVICE_ENV}</key><string>1</string>{home_entry}
  </dict>
</dict>
</plist>
"#,
        exe = xml_escape(exe),
        path = xml_escape(path),
    )
}

pub fn systemd_unit(exe: &str, path: &str, home: Option<&str>) -> String {
    let home_line = home
        .map(|h| format!("Environment=\"SLING_RUNNER_HOME={h}\"\n"))
        .unwrap_or_default();
    format!(
        "[Unit]\n\
         Description=Sling Runner\n\
         After=network-online.target\n\
         Wants=network-online.target\n\n\
         [Service]\n\
         ExecStart=\"{exe}\" run\n\
         Restart=on-failure\n\
         RestartSec=5\n\
         RestartPreventExitStatus={EXIT_REVOKED}\n\
         Environment=\"PATH={path}\"\n\
         Environment=\"{SERVICE_ENV}=1\"\n\
         {home_line}\n\
         [Install]\n\
         WantedBy=default.target\n"
    )
}

/// The Windows logon task. `conhost --headless` hosts the Runner's console
/// without a window, so there's no window to close, and the commands the
/// Runner starts share that console instead of opening their own. Task
/// Scheduler's defaults would also keep it from starting on battery, stop it
/// when the laptop unplugs, and end it after 3 days.
pub fn windows_task_xml(exe: &str, user: Option<&str>) -> String {
    let user_id = user
        .map(|u| format!("\n      <UserId>{}</UserId>", xml_escape(u)))
        .unwrap_or_default();
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Sling Runner: runs Sling tasks on this machine while you're logged in.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>{user_id}
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">{user_id}
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>%SystemRoot%\System32\conhost.exe</Command>
      <Arguments>--headless "{exe}" run --service</Arguments>
    </Exec>
  </Actions>
</Task>
"#,
        exe = xml_escape(exe),
    )
}

/// `DOMAIN\user` for the task to run as, from the logged-in session.
fn windows_user() -> Option<String> {
    let user = std::env::var("USERNAME").ok().filter(|u| !u.is_empty())?;
    Some(match std::env::var("USERDOMAIN") {
        Ok(domain) if !domain.is_empty() => format!("{domain}\\{user}"),
        _ => user,
    })
}

/// `C:\...` for `\\?\C:\...`, the form `canonicalize` gives on Windows,
/// which not every program accepts on its command line.
pub fn without_verbatim_prefix(path: &str) -> &str {
    match path.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with(r"UNC\") => rest,
        _ => path,
    }
}

/// UTF-16 with a byte order mark, the encoding schtasks reads task XML in.
pub fn utf16_with_bom(text: &str) -> Vec<u8> {
    std::iter::once(0xFEFF)
        .chain(text.encode_utf16())
        .flat_map(u16::to_le_bytes)
        .collect()
}

/// Ends the logon task and the Runner it started, with everything the Runner
/// started. Ending the task alone only ends conhost.
async fn stop_windows_task() {
    let _ = sh("schtasks", &["/End", "/TN", TASK]).await;
    let script = "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'sling-runner.exe' -and $_.CommandLine -match '\\srun --service\\s*$' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null }";
    let _ = sh(
        "powershell",
        &["-NoProfile", "-NonInteractive", "-Command", script],
    )
    .await;
}

async fn sh(program: &str, args: &[&str]) -> Result<crate::sys::Output> {
    crate::sys::run(program, args, None).await
}

pub async fn install(paths: &Paths) -> Result<String> {
    let exe = exe()?;
    let exe = exe.display().to_string();
    let path = path_env();
    let home = home_env();
    std::fs::create_dir_all(&paths.data_dir)?;
    if cfg!(target_os = "macos") {
        let uid = sh("id", &["-u"]).await?.stdout.trim().to_string();
        let dir = dirs_home()?.join("Library/LaunchAgents");
        std::fs::create_dir_all(&dir)?;
        let file = dir.join(format!("{LABEL}.plist"));
        std::fs::write(&file, launchd_plist(&exe, &path, home.as_deref()))?;
        let target = format!("gui/{uid}");
        let _ = sh("launchctl", &["bootout", &format!("{target}/{LABEL}")]).await;
        let out = sh(
            "launchctl",
            &["bootstrap", &target, &file.display().to_string()],
        )
        .await?;
        if !out.ok() {
            bail!("launchctl bootstrap failed: {}", out.stderr.trim());
        }
        Ok(format!(
            "Installed {}. Logs: {}",
            file.display(),
            paths.log_file().display()
        ))
    } else if cfg!(target_os = "linux") {
        let dir = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or(dirs_home()?.join(".config"))
            .join("systemd/user");
        std::fs::create_dir_all(&dir)?;
        let file = dir.join("sling-runner.service");
        std::fs::write(&file, systemd_unit(&exe, &path, home.as_deref()))?;
        for args in [
            &["--user", "daemon-reload"][..],
            &["--user", "enable", "sling-runner.service"][..],
            // Replaces a Runner that's already running, with its old binary
            // and key.
            &["--user", "restart", "sling-runner.service"][..],
        ] {
            let out = sh("systemctl", args).await?;
            if !out.ok() {
                bail!("systemctl {} failed: {}", args.join(" "), out.stderr.trim());
            }
        }
        Ok(format!(
            "Installed {}. Logs: {}\nTo keep it running while you're logged out: loginctl enable-linger $USER",
            file.display(),
            paths.log_file().display()
        ))
    } else if cfg!(windows) {
        let xml = windows_task_xml(without_verbatim_prefix(&exe), windows_user().as_deref());
        let file = std::env::temp_dir().join("sling-runner-task.xml");
        std::fs::write(&file, utf16_with_bom(&xml))?;
        // A Runner from an earlier install, which may still have a window open.
        stop_windows_task().await;
        let out = sh(
            "schtasks",
            &[
                "/Create",
                "/TN",
                TASK,
                "/XML",
                &file.display().to_string(),
                "/F",
            ],
        )
        .await;
        let _ = std::fs::remove_file(&file);
        let out = out?;
        if !out.ok() {
            bail!("schtasks /Create failed: {}", out.stderr.trim());
        }
        let _ = sh("schtasks", &["/Run", "/TN", TASK]).await;
        Ok(format!(
            "Installed the {TASK} logon task. It runs in the background while you're logged in. Logs: {}",
            paths.log_file().display()
        ))
    } else {
        bail!("service install isn't supported on this OS; run `sling-runner run` instead")
    }
}

pub async fn uninstall() -> Result<String> {
    if cfg!(target_os = "macos") {
        let uid = sh("id", &["-u"]).await?.stdout.trim().to_string();
        let _ = sh("launchctl", &["bootout", &format!("gui/{uid}/{LABEL}")]).await;
        let file = dirs_home()?.join(format!("Library/LaunchAgents/{LABEL}.plist"));
        let _ = std::fs::remove_file(&file);
        Ok("Removed the LaunchAgent.".into())
    } else if cfg!(target_os = "linux") {
        let _ = sh(
            "systemctl",
            &["--user", "disable", "--now", "sling-runner.service"],
        )
        .await;
        let dir = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or(dirs_home()?.join(".config"));
        let _ = std::fs::remove_file(dir.join("systemd/user/sling-runner.service"));
        let _ = sh("systemctl", &["--user", "daemon-reload"]).await;
        Ok("Removed the systemd user unit.".into())
    } else if cfg!(windows) {
        stop_windows_task().await;
        let _ = sh("schtasks", &["/Delete", "/TN", TASK, "/F"]).await;
        Ok(format!("Removed the {TASK} task."))
    } else {
        bail!("not supported on this OS")
    }
}

pub async fn status() -> Result<String> {
    if cfg!(target_os = "macos") {
        let uid = sh("id", &["-u"]).await?.stdout.trim().to_string();
        let out = sh("launchctl", &["print", &format!("gui/{uid}/{LABEL}")]).await?;
        if !out.ok() {
            return Ok("not installed".into());
        }
        let state = out
            .stdout
            .lines()
            .find_map(|l| l.trim().strip_prefix("state = "))
            .unwrap_or("unknown");
        Ok(format!("installed, {state}"))
    } else if cfg!(target_os = "linux") {
        let out = sh(
            "systemctl",
            &["--user", "is-active", "sling-runner.service"],
        )
        .await?;
        Ok(out.stdout.trim().to_string())
    } else if cfg!(windows) {
        let out = sh("schtasks", &["/Query", "/TN", TASK, "/FO", "LIST"]).await?;
        if !out.ok() {
            return Ok("not installed".into());
        }
        Ok(out
            .stdout
            .lines()
            .find(|l| l.starts_with("Status:"))
            .unwrap_or("installed")
            .to_string())
    } else {
        Ok("not supported on this OS".into())
    }
}

fn dirs_home() -> Result<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .context("HOME is not set")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plist_keeps_path_and_marks_service_mode() {
        let p = launchd_plist(
            "/usr/local/bin/sling-runner",
            "/opt/homebrew/bin:/usr/bin",
            None,
        );
        assert!(p.contains("<string>/usr/local/bin/sling-runner</string><string>run</string>"));
        assert!(p.contains("/opt/homebrew/bin:/usr/bin"));
        assert!(p.contains("SLING_RUNNER_SERVICE"));
        assert!(p.contains("<key>SuccessfulExit</key><false/>"));
    }

    #[test]
    fn windows_task_runs_without_a_window_on_battery_and_without_a_time_limit() {
        let x = windows_task_xml(r"C:\Users\Tiago & Co\sling-runner.exe", Some(r"PC\tiago"));
        assert!(x.contains(r"<Command>%SystemRoot%\System32\conhost.exe</Command>"));
        assert!(x.contains(
            r#"<Arguments>--headless "C:\Users\Tiago &amp; Co\sling-runner.exe" run --service</Arguments>"#
        ));
        assert!(x.contains("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>"));
        assert!(x.contains("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>"));
        assert!(x.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"));
        assert_eq!(x.matches(r"<UserId>PC\tiago</UserId>").count(), 2);
        assert!(!windows_task_xml("x", None).contains("UserId"));
    }

    #[test]
    fn windows_paths_lose_the_verbatim_prefix_and_xml_is_utf16() {
        assert_eq!(
            without_verbatim_prefix(r"\\?\C:\bin\sling-runner.exe"),
            r"C:\bin\sling-runner.exe"
        );
        assert_eq!(
            without_verbatim_prefix(r"\\?\UNC\host\share\x.exe"),
            r"\\?\UNC\host\share\x.exe"
        );
        assert_eq!(without_verbatim_prefix(r"C:\x.exe"), r"C:\x.exe");
        assert_eq!(
            utf16_with_bom("<a/>"),
            [0xFF, 0xFE, b'<', 0, b'a', 0, b'/', 0, b'>', 0]
        );
    }

    #[test]
    fn systemd_unit_never_restarts_a_revoked_runner() {
        let u = systemd_unit("/usr/bin/sling-runner", "/usr/bin", Some("/srv/r"));
        assert!(u.contains("RestartPreventExitStatus=78"));
        assert!(u.contains("ExecStart=\"/usr/bin/sling-runner\" run"));
        assert!(u.contains("SLING_RUNNER_HOME=/srv/r"));
    }
}
