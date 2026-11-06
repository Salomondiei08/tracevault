/**
 * Installs a nightly sync job: a launchd agent on macOS, printed systemd units on Linux.
 * Running nightly (not continuously) keeps cost and battery impact negligible, and the
 * idle window means sessions are uploaded once they are finished.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { appHome } from "./config";

const LABEL = "dev.tracevault.sync";

/** Returns what was done, for the CLI to print. */
export function installSchedule(cliPath: string, hour = 3): string {
  const node = process.execPath;
  const logFile = join(appHome(), "sync.log");
  if (platform() === "darwin") {
    const plist = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${node}</string><string>--no-warnings</string><string>${cliPath}</string><string>sync</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${process.env.PATH ?? "/usr/bin:/bin"}</string></dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>${logFile}</string>
  <key>StandardErrorPath</key><string>${logFile}</string>
</dict>
</plist>
`,
    );
    const uid = String(process.getuid?.() ?? "");
    try {
      execFileSync("launchctl", ["bootout", `gui/${uid}/${LABEL}`], { stdio: "ignore" });
    } catch {
      /* not loaded yet */
    }
    execFileSync("launchctl", ["bootstrap", `gui/${uid}`, plist]);
    return `Installed ${plist}: syncs daily at ${hour}:00 (missed runs happen at next wake). Log: ${logFile}`;
  }
  return `On Linux, create ~/.config/systemd/user/tracevault.service with
  [Service]
  ExecStart=${node} --no-warnings ${cliPath} sync
and ~/.config/systemd/user/tracevault.timer with
  [Timer]
  OnCalendar=*-*-* 0${hour}:00:00
  Persistent=true
  [Install]
  WantedBy=timers.target
then run: systemctl --user enable --now tracevault.timer`;
}
