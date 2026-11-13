import { app, BrowserWindow, dialog, protocol, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import type { GuiEvent } from "../gui/shared/protocol/events.ts";
import { GUI_BACKGROUNDS } from "../gui/shared/theme.ts";
import { BackendClient } from "./backend-client.ts";
import type { BackendMessage } from "./backend-contract.ts";
import { showDesktopNotification } from "./notifications.ts";
import { resolveShellEnvironment } from "./shell-environment.ts";
import { forkDesktopWorker } from "./worker-services.ts";
import { DesktopDiagnostics } from "./diagnostics.ts";
import { installDesktopShutdown } from "./shutdown.ts";
import { createDesktopWindowState } from "./window-state.ts";
import { installDesktopMenu } from "./menu.ts";
import { DesktopTaskStatus } from "./task-status.ts";
import { installDesktopPower } from "./power.ts";
import { desktopScheme, installDesktopLaunch, parseLaunchUrl } from "./launch.ts";
import { installDesktopIpc } from "./ipc.ts";
import { desktopEntryUrl, installDesktopProtocol } from "./protocol.ts";

protocol.registerSchemesAsPrivileged([
	{ scheme: "opi", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
const directory = path.dirname(fileURLToPath(import.meta.url));
const icon = path.join(directory, "icons", process.platform === "win32" ? "icon.ico" : process.platform === "darwin" ? "icon-macos.png" : "icon.png");
if (process.platform === "win32") app.setAppUserModelId("dev.orion.opi");
const report = (error: unknown) => dialog.showErrorBox("Desktop 操作失败", error instanceof Error ? error.message : String(error));

async function saveDownload(event: Extract<GuiEvent, { type: "download" }>, client: BackendClient): Promise<void> {
	const result = await dialog.showSaveDialog({
		defaultPath: path.join(app.getPath("downloads"), path.basename(event.name)),
	});
	if (result.canceled || !result.filePath) return;
	await writeFile(result.filePath, event.content, { mode: 0o600 });
	client.send({ kind: "feedback", message: `已导出 ${path.basename(result.filePath)}`, tone: "success" });
}

async function startDesktop(): Promise<void> {
	function focusWindow(): void {
		const window = BrowserWindow.getAllWindows()[0];
		if (!window) return;
		if (window.isMinimized()) window.restore();
		window.show(); window.focus();
	}
	const launches = installDesktopLaunch(focusWindow, report);
	async function openExternal(url: string): Promise<void> {
		const scheme = new URL(url).protocol;
		if (scheme === `${desktopScheme}:`) { launches.enqueue(parseLaunchUrl(url)); return; }
		if (!["https:", "http:", "mailto:"].includes(scheme)) throw new Error("不允许打开此协议。");
		return shell.openExternal(url);
	}

	await app.whenReady();
	if (app.isPackaged && !app.setAsDefaultProtocolClient(desktopScheme)) console.error("无法注册 Desktop 链接协议。");
	let environment = process.env;
	if (process.platform === "darwin") {
		app.dock?.setIcon(icon);
		try {
			environment = await resolveShellEnvironment(app.getPath("home"), process.env);
		} catch {
			await dialog.showMessageBox({
				type: "warning",
				message: "无法加载终端环境",
				detail: "登录 shell 执行失败或超过 10 秒。将使用应用原有环境，部分命令可能不可用。请检查 shell 启动配置后重启应用。",
			});
		}
	}
	const diagnostics = new DesktopDiagnostics(path.join(app.getPath("logs"), "gui-timing.jsonl"), process.env.OPI_GUI_DEBUG === "1");
	const windowState = createDesktopWindowState();
	const window = new BrowserWindow({
		...windowState.options,
		title: "opi-desktop",
		icon,
		backgroundColor: GUI_BACKGROUNDS.dark,
		transparent: process.platform === "linux",
		// macOS 需在创建时初始化半透明合成，避免后期开启材质时文字动画触发闪烁。
		...(process.platform === "darwin" ? { vibrancy: "hud" } : {}),
		visualEffectState: "followWindow",
		webPreferences: {
			preload: path.join(directory, "preload.cjs"),
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	windowState.install(window);
	const backendDirectory = path.basename(directory) === "app.asar" ? `${directory}.unpacked` : directory;
	const backend = forkDesktopWorker(path.join(backendDirectory, "backend.mjs"), [app.getPath("home")], {
		stdio: "pipe", serviceName: "opi-desktop SDK", env: { ...environment, OPI_GUI_DEBUG: diagnostics.debug ? "1" : "0" },
	});
	const client = new BackendClient(backend, diagnostics);
	const reportOperation = (error: unknown) => client.send({ kind: "feedback", message: error instanceof Error ? error.message : String(error), tone: "error" });
	const taskStatus = new DesktopTaskStatus(window, path.join(directory, "icons", "attention.png"));
	const power = installDesktopPower(() => window.webContents.send("gui:command", "resume"),
		(message) => client.send({ kind: "feedback", message, tone: "warning" }));
	const menu = installDesktopMenu(window, async (directory) => {
		try {
			if (directory) { launches.enqueue({ action: "workspace", path: directory }); return; }
			const { canceled, filePaths: [selected] } = await dialog.showOpenDialog(window, { properties: ["openDirectory"] });
			if (!canceled && selected) launches.enqueue({ action: "workspace", path: selected });
		} catch (error) { reportOperation(error); }
	});
	window.once("closed", () => power.dispose());
	window.on("focus", () => window.flashFrame(false));
	window.webContents.on("will-navigate", (event) => event.preventDefault());
	window.webContents.setWindowOpenHandler(({ url }) => {
		void openExternal(url).catch(reportOperation);
		return { action: "deny" };
	});
	backend.on("message", (message: BackendMessage) => {
		switch (message.kind) {
			case "delivery": {
				const { value: delivery, at } = message;
				if (delivery.kind === "notification") {
					showDesktopNotification(window, delivery.value, icon, () => {
						focusWindow();
						void client.request({ kind: "action", value: { sessionId: null, value: { action: "openSession", id: delivery.value.sessionId } } })
							.catch(reportOperation);
					});
					return;
				}
				const events = delivery.events.filter((event) => {
					if (event.type === "close") { app.quit(); return false; }
					if (event.type !== "download") return true;
					void saveDownload(event, client).catch((error: unknown) => client.send({ kind: "feedback", message: `导出失败：${error instanceof Error ? error.message : String(error)}`, tone: "error" }));
					return false;
				});
				if (!window.isDestroyed()) {
					const traced = diagnostics.delivery(delivery, at);
					window.webContents.send("gui:event", { ...delivery, events }, traced);
				}
				return;
			}
			case "desktopState": {
				if (window.isDestroyed()) return;
				const event = message.value;
				switch (event.type) {
					case "activity": power.activity(taskStatus.update(event.value)); break;
					case "guiConfig": if (event.value.state === "ready") power.configure(event.value.value.preventSleepWhileRunning); break;
					case "selected": if (event.session) menu.select(event.session.cwd); break;
					case "workspaces": menu.workspaces(event.value); break;
				}
				return;
			}
			case "webError":
				void dialog.showMessageBox({
					type: "warning", message: "Web 访问未启动",
					detail: `${message.message}\n桌面端可继续使用。请在设置中修正 Web 访问配置后重启 Desktop。`,
				});
				return;
			case "ready":
				launches.ready(async (action) => {
					await client.request({ kind: "action", value: { sessionId: null, value: action } });
					focusWindow();
				});
		}
	});
	backend.once("exit", (code) => {
		power.dispose();
		if (!window.isDestroyed()) taskStatus.clear();
		if (!client.stopping) dialog.showErrorBox("SDK 后端已退出", `退出码 ${code}。请重启应用。`);
	});
	installDesktopProtocol(directory, client);
	installDesktopIpc(window, client, diagnostics, taskStatus, openExternal);
	installDesktopShutdown(window, client, diagnostics);
	app.on("window-all-closed", () => app.quit());
	await window.loadURL(desktopEntryUrl);
}

if (app.requestSingleInstanceLock()) void startDesktop().catch((error: unknown) => {
	dialog.showErrorBox("启动失败", String(error));
	app.quit();
});
else app.quit();
