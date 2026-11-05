# S3. Runner as a background service

The Runner has to run as the logged-in user so it can use that user's Codex login and git credentials (D20). That rules out system-wide services that run as root or LocalSystem.

| OS | Mechanism | Where it lives |
|---|---|---|
| macOS | launchd LaunchAgent, `RunAtLoad` + `KeepAlive` | `~/Library/LaunchAgents/dev.sling.runner.plist`, loaded with `launchctl bootstrap gui/$UID` |
| Linux | systemd user unit, `Restart=on-failure` | `~/.config/systemd/user/sling-runner.service`, `systemctl --user enable --now`. Needs `loginctl enable-linger` to run while logged out |
| Windows | Scheduled task at logon, restart on failure | `schtasks /Create /SC ONLOGON /RL LIMITED /TN SlingRunner` |

A Windows service would run as LocalSystem or need the user's password stored, so a logon task is the better fit. The catch is that it only runs while the user is logged in. That's acceptable for a dev machine and worth stating in the docs.

`sling-runner service install` writes the file for the current OS and starts it. `service uninstall` stops and removes it. `service status` reports whether it's loaded and running. Logs go to `<config dir>/runner.log`, rotated at 10 MB.

macOS and Linux get implemented and tested in Stage 1. Windows gets the scheduled-task code but no test on real hardware yet.
