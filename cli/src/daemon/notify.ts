import { platform } from "node:os";
import { execFile } from "node:child_process";

export function sendNotification(title: string, body: string) {
  const os = platform();

  if (os === "darwin") {
    // macOS — osascript
    execFile("osascript", [
      "-e",
      `display notification "${body.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`,
    ]);
  } else if (os === "win32") {
    // Windows — PowerShell toast notification
    const ps = `
      [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
      [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
      $xml = [Windows.Data.Xml.Dom.XmlDocument]::new()
      $xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>${title}</text><text>${body}</text></binding></visual></toast>")
      [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Trunk").Show([Windows.UI.Notifications.ToastNotification]::new($xml))
    `.trim();
    execFile("powershell", ["-Command", ps]);
  } else {
    // Linux — notify-send (libnotify)
    execFile("notify-send", [title, body]);
  }
}
