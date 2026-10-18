import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAttention, type Attention } from "../harness/attention.ts";

function notificationCommand(event: Attention): { file: string; args: string[]; env: NodeJS.ProcessEnv } | undefined {
	const text = (event.name?.trim() || event.firstMessage).replace(/\s+/gu, " ").trim() || "新会话";
	const characters = [...text];
	const label = characters.slice(0, 80).join("") + (characters.length > 80 ? "…" : "");
	const title = event.kind === "approval" ? "OPi 需要审批" : "OPi 任务完成";
	const body = event.kind === "approval" ? `${label}\n${event.toolName} 请求执行权限` : label;
	const silent = event.kind === "completed";
	const env = { ...process.env, OPI_NOTIFICATION_TITLE: title, OPI_NOTIFICATION_BODY: body };
	switch (process.platform) {
		case "linux": return {
			file: "notify-send", env,
			args: [
				"--app-name=OPi", "--urgency=normal",
				...(silent ? ["--hint=boolean:suppress-sound:true"] : []),
				"--", title, body.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
			],
		};
		case "darwin": return {
			file: "osascript", env,
			args: ["-e", `display notification (system attribute "OPI_NOTIFICATION_BODY") with title (system attribute "OPI_NOTIFICATION_TITLE")${silent ? "" : ' sound name "default"'}`],
		};
		case "win32": return {
			file: "powershell.exe", env,
			args: ["-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$id = 'dev.orion.opi.tui'
$key = "HKCU:\\Software\\Classes\\AppUserModelId\\$id"
New-Item -Path $key -Force > $null
New-ItemProperty -Path $key -Name DisplayName -Value 'OPi' -PropertyType String -Force > $null
$xml = [Windows.Data.Xml.Dom.XmlDocument]::new()
$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text/><text/></binding></visual>${silent ? '<audio silent="true"/>' : ""}</toast>')
$text = $xml.GetElementsByTagName('text')
$text.Item(0).InnerText = $env:OPI_NOTIFICATION_TITLE
$text.Item(1).InnerText = $env:OPI_NOTIFICATION_BODY
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
`],
		};
		default: return undefined;
	}
}

function sendTerminalNotification(event: Attention): void {
	if (process.env.OPI_NO_NOTIFICATIONS === "1") return;
	const command = notificationCommand(event);
	if (!command) return;
	// 无效进程参数、缺失后端及执行失败均不得中断审批。
	try { execFile(command.file, command.args, { env: command.env, timeout: 5000, windowsHide: true }, () => {}); }
	catch { /* 用户消息可能包含系统进程参数不接受的 NUL。 */ }
}

export default function terminalNotifications(pi: ExtensionAPI): void {
	let focused: boolean | undefined;
	let active = false;
	let removeInput: (() => void) | undefined;
	const stop = () => {
		removeInput?.(); removeInput = undefined;
		if (active && process.stdout.isTTY) process.stdout.write("\x1b[?1004l");
		active = false; focused = undefined;
	};
	pi.on("session_start", (_event, ctx) => {
		stop();
		if (ctx.mode !== "tui") return;
		active = true;
		removeInput = ctx.ui.onTerminalInput((data) => {
			if (data === "\x1b[I" || data === "\x1b[O") {
				focused = data === "\x1b[I";
				return { consume: true };
			}
			return undefined;
		});
		if (process.stdout.isTTY) process.stdout.write("\x1b[?1004h");
	});
	pi.on("session_shutdown", stop);
	registerAttention(pi, (event) => { if (active && focused !== true) sendTerminalNotification(event); });
}
