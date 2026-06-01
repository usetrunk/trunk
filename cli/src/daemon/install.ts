#!/usr/bin/env node
import { platform, homedir } from "node:os";
import { writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

const os = platform();
const home = homedir();
const executeMode = process.argv.includes("--execute");
const executeArgument = executeMode ? "    <string>--execute</string>\n" : "";

// Find the daemon script path
const daemonScript = resolve(import.meta.dirname, "index.ts");

if (os === "darwin") {
  // macOS — launchd plist
  const plistDir = join(home, "Library", "LaunchAgents");
  const plistPath = join(plistDir, "bot.trunk.daemon.plist");

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>bot.trunk.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>npx</string>
    <string>tsx</string>
    <string>${daemonScript}</string>
${executeArgument}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${join(home, ".trunk", "daemon.log")}</string>
  <key>StandardErrorPath</key>
  <string>${join(home, ".trunk", "daemon.log")}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>`;

  mkdirSync(plistDir, { recursive: true });
  mkdirSync(join(home, ".trunk"), { recursive: true });
  writeFileSync(plistPath, plist);

  try {
    execSync(`launchctl unload ${plistPath} 2>/dev/null`, { stdio: "ignore" });
  } catch {}
  execSync(`launchctl load ${plistPath}`);

  console.log(`[trunk] daemon installed (macOS launchd, ${executeMode ? "execute" : "notify"} mode)`);
  console.log(`[trunk] plist: ${plistPath}`);
  console.log(`[trunk] logs: ~/.trunk/daemon.log`);
  console.log("[trunk] to uninstall: launchctl unload ~/Library/LaunchAgents/bot.trunk.daemon.plist");

} else if (os === "linux") {
  // Linux — systemd user service
  const serviceDir = join(home, ".config", "systemd", "user");
  const servicePath = join(serviceDir, "trunk-daemon.service");

  const service = `[Unit]
Description=Trunk notification daemon
After=network.target

[Service]
ExecStart=npx tsx ${daemonScript}${executeMode ? " --execute" : ""}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;

  mkdirSync(serviceDir, { recursive: true });
  mkdirSync(join(home, ".trunk"), { recursive: true });
  writeFileSync(servicePath, service);

  execSync("systemctl --user daemon-reload");
  execSync("systemctl --user enable trunk-daemon");
  execSync("systemctl --user start trunk-daemon");

  console.log(`[trunk] daemon installed (systemd user service, ${executeMode ? "execute" : "notify"} mode)`);
  console.log(`[trunk] service: ${servicePath}`);
  console.log("[trunk] to check: systemctl --user status trunk-daemon");
  console.log("[trunk] to uninstall: systemctl --user disable --now trunk-daemon");

} else if (os === "win32") {
  // Windows — startup script
  const startupDir = join(home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  const batPath = join(startupDir, "trunk-daemon.bat");

  const bat = `@echo off
npx tsx "${daemonScript}"${executeMode ? " --execute" : ""}
`;

  writeFileSync(batPath, bat);

  console.log(`[trunk] daemon installed (Windows startup script, ${executeMode ? "execute" : "notify"} mode)`);
  console.log(`[trunk] script: ${batPath}`);
  console.log("[trunk] to uninstall: delete the file above");

} else {
  console.error(`[trunk] unsupported platform: ${os}`);
  process.exit(1);
}
