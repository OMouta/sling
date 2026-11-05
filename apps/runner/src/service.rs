//! `sling-runner service install|uninstall|status`. The Runner
//! runs as the logged-in user so it can use that user's Codex login and git
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

fn exe() -> Result<PathBuf> {
    std::env::current_exe()?
        .canonicalize()
        .context("finding the sling-runner binary")
}

/// PATH at install time. Service managers start with a bare PATH, which would
/// hide codex, git, and gh.
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
            &["--user", "enable", "--now", "sling-runner.service"][..],
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
        let tr = format!("\"{exe}\" run");
        let out = sh(
            "schtasks",
            &[
                "/Create",
                "/SC",
                "ONLOGON",
                "/RL",
                "LIMITED",
                "/TN",
                "SlingRunner",
                "/TR",
                &tr,
                "/F",
            ],
        )
        .await?;
        if !out.ok() {
            bail!("schtasks /Create failed: {}", out.stderr.trim());
        }
        let _ = sh("schtasks", &["/Run", "/TN", "SlingRunner"]).await;
        Ok(format!(
            "Installed the SlingRunner logon task. It runs while you're logged in. Logs: {}",
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
        let _ = sh("schtasks", &["/End", "/TN", "SlingRunner"]).await;
        let _ = sh("schtasks", &["/Delete", "/TN", "SlingRunner", "/F"]).await;
        Ok("Removed the SlingRunner task.".into())
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
        let out = sh("schtasks", &["/Query", "/TN", "SlingRunner", "/FO", "LIST"]).await?;
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
    fn systemd_unit_never_restarts_a_revoked_runner() {
        let u = systemd_unit("/usr/bin/sling-runner", "/usr/bin", Some("/srv/r"));
        assert!(u.contains("RestartPreventExitStatus=78"));
        assert!(u.contains("ExecStart=\"/usr/bin/sling-runner\" run"));
        assert!(u.contains("SLING_RUNNER_HOME=/srv/r"));
    }
}
