import {
	app,
	BrowserWindow,
	dialog,
	ipcMain,
	net,
	protocol,
	shell,
	type IpcMainInvokeEvent,
} from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import type { GuiEvent } from "../gui/shared/protocol/events.ts";
import { GUI_BACKGROUNDS } from "../gui/shared/theme.ts";
import { BackendClient } from "./backend-client.ts";
import { showDesktopNotification, trackDesktopAttention } from "./notifications.ts";
import { resolveShellEnvironment } from "./shell-environment.ts";
import { forkDesktopWorker } from "./worker-services.ts";
import { DesktopDiagnostics } from "./diagnostics.ts";
import { installDesktopFaults } from "./faults.ts";
import { DesktopStorage } from "./storage.ts";
import { installDesktopAppearance } from "./appearance.ts";
import { installDesktopShutdown } from "./shutdown.ts";
import { createDesktopWindowState } from "./window-state.ts";
import { fileResourceResponse, type FileResource } from "../gui/host/workspace/file-resource.ts";
import { desktopFile, openDesktopFile, showFileMenu, startFileDrag, prepareFileDrop } from "./file-integration.ts";
import { installDesktopMenu } from "./menu.ts";
import { DesktopTaskStatus } from "./task-status.ts";
import { installDesktopPower } from "./power.ts";
import { desktopScheme, installDesktopLaunch, launchAction, parseLaunchUrl } from "./launch.ts";

protocol.registerSchemesAsPrivileged([
	{ scheme: "opi", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
const directory = path.dirname(fileURLToPath(import.meta.url));
const icon = path.join(directory, "icons", process.platform === "win32" ? "icon.ico" : process.platform === "darwin" ? "icon-macos.png" : "icon.png");
if (process.platform === "win32") app.setAppUserModelId("dev.orion.opi");
const entryUrl = "opi://app/index.html";
const report = (error: unknown) => dialog.showErrorBox("Desktop 操作失败", error instanceof Error ? error.message : String(error));

async function saveDownload(event: Extract<GuiEvent, { type: "download" }>, client: BackendClient): Promise<void> {
	const result = await dialog.showSaveDialog({
		defaultPath: path.join(app.getPath("downloads"), path.basename(event.name)),
	});
	if (result.canceled || !result.filePath) return;
	await writeFile(result.filePath, event.content, { mode: 0o600 });
	client.send({ kind: "notice", text: `已导出: ${result.filePath}` });
}

function startDesktop(): void {
	let window: BrowserWindow | undefined;
	function focusWindow(): void {
		if (!window || window.isDestroyed()) return;
		if (window.isMinimized()) window.restore();
		window.show(); window.focus();
	}
	function trusted(event: IpcMainInvokeEvent): void {
		if (
			!window ||
			event.sender !== window.webContents ||
			event.senderFrame !== window.webContents.mainFrame ||
			event.senderFrame.url !== entryUrl
		)
			throw new Error("Untrusted renderer");
	}
	const launches = installDesktopLaunch(focusWindow, report);
	async function openExternal(url: string): Promise<void> {
		const scheme = new URL(url).protocol;
		if (scheme === `${desktopScheme}:`) { launches.enqueue(parseLaunchUrl(url)); return; }
		if (!["https:", "http:", "mailto:"].includes(scheme)) throw new Error("不允许打开此协议。");
		return shell.openExternal(url);
	}

	void app.whenReady().then(async () => {
		if (app.isPackaged && !app.setAsDefaultProtocolClient(desktopScheme)) console.error("无法注册 Desktop 链接协议。");
		const diagnostics = new DesktopDiagnostics(path.join(app.getPath("logs"), "gui-timing.jsonl"));
		const storage = new DesktopStorage(diagnostics);
		ipcMain.handle("gui:storage", (event) => { trusted(event); return storage.read(); });
		ipcMain.handle("gui:clearStorage", (event, ids: unknown) => { trusted(event); return storage.clear(ids); });
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
		protocol.handle("opi", async (request) => {
			const url = new URL(request.url);
			if (url.hostname !== "app") return new Response("Forbidden", { status: 403 });
			if (url.pathname === "/api/file") {
				try {
					const resource = await client.request("resource", url.searchParams.get("token"), undefined) as FileResource;
					return await fileResourceResponse(resource, request);
				} catch (error) {
					return new Response(error instanceof Error ? error.message : String(error), { status: 403 });
				}
			}
			const root = path.join(directory, "ui");
			const target = path.resolve(root, decodeURIComponent(url.pathname).slice(1));
			const relative = path.relative(root, target);
			if (relative.startsWith("..") || path.isAbsolute(relative)) return new Response("Forbidden", { status: 403 });
			const response = await net.fetch(pathToFileURL(target).href);
			const headers = new Headers(response.headers);
			headers.set(
				"Content-Security-Policy",
				"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
			);
			headers.set("X-Content-Type-Options", "nosniff");
			return new Response(response.body, { status: response.status, headers });
		});
		const windowState = createDesktopWindowState();
		window = new BrowserWindow({
			...windowState.options,
			title: "opi-desktop",
			icon,
			backgroundColor: GUI_BACKGROUNDS.dark,
			transparent: process.platform === "linux",
			visualEffectState: "followWindow",
			webPreferences: {
				preload: path.join(directory, "preload.cjs"),
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
			},
		});
		windowState.install(window);
		const reportDiagnostic = installDesktopFaults(window, diagnostics);
		ipcMain.handle("gui:diagnostic", (event, value: unknown) => { trusted(event); return reportDiagnostic(value); });
		const setAppearance = installDesktopAppearance(window);
		ipcMain.handle("gui:appearance", (event, value: unknown) => {
			trusted(event);
			return setAppearance(value);
		});
		const desktopWindow = window;
		const taskStatus = new DesktopTaskStatus(desktopWindow, path.join(directory, "icons", "attention.png"));
		const power = installDesktopPower(() => desktopWindow.webContents.send("gui:command", "resume"),
			(text) => client.send({ kind: "notice", text }));
		const menu = installDesktopMenu(desktopWindow, (directory) => {
			void (async () => {
				if (!directory) {
					const result = await dialog.showOpenDialog(desktopWindow, { properties: ["openDirectory"] });
					if (result.canceled) return;
					directory = result.filePaths[0];
				}
				if (directory) launches.enqueue({ kind: "workspace", path: directory });
			})().catch(report);
		});
		window.once("closed", () => power.dispose());
		ipcMain.on("gui:markRead", (event, id: unknown, at: unknown) => { trusted(event); taskStatus.markRead(id, at); });
		ipcMain.handle("gui:fileMenu", async (event, cwd: unknown, name: unknown) => {
			trusted(event); await showFileMenu(desktopWindow, await desktopFile(cwd, name), report);
		});
		ipcMain.handle("gui:startDrag", async (event, cwd: unknown, name: unknown) => {
			trusted(event); await startFileDrag(desktopWindow, await desktopFile(cwd, name));
		});
		ipcMain.handle("gui:drop", async (event, cwd: unknown, files: unknown) => {
			trusted(event); return prepareFileDrop(desktopWindow, cwd, files);
		});
		window.on("focus", () => desktopWindow.flashFrame(false));
		window.webContents.on("will-navigate", (event) => event.preventDefault());
		window.webContents.setWindowOpenHandler(({ url }) => {
			void openExternal(url).catch((error: unknown) => dialog.showErrorBox("无法打开链接", String(error)));
			return { action: "deny" };
		});
		const backendDirectory = path.basename(directory) === "app.asar" ? `${directory}.unpacked` : directory;
		const client = new BackendClient(
			forkDesktopWorker(path.join(backendDirectory, "backend.mjs"), [app.getPath("home")], {
				stdio: "pipe", serviceName: "opi-desktop SDK", env: environment,
			}),
			diagnostics,
			{
				onDelivery: (delivery, at) => {
					if (delivery.kind === "notification") {
						showDesktopNotification(desktopWindow, delivery.value, icon, () => {
							focusWindow();
							void client.request("action", { sessionId: null, value: { action: "openSession", id: delivery.value.sessionId } }, undefined)
								.catch((error: unknown) => client.send({ kind: "notice", text: String(error) }));
						});
						return;
					}
					const events = delivery.events.filter((event) => {
						if (event.type === "close") { app.quit(); return false; }
						if (event.type !== "download") return true;
						void saveDownload(event, client).catch((error: unknown) => dialog.showErrorBox("导出失败", String(error)));
						return false;
					});
					if (!desktopWindow.isDestroyed()) {
						const traced = diagnostics.delivery(delivery, at);
						desktopWindow.webContents.send("gui:event", { ...delivery, events }, traced);
					}
				},
				onExit: (code, stopping) => {
					power.dispose();
					if (!desktopWindow.isDestroyed()) taskStatus.clear();
					if (stopping) app.quit();
					else dialog.showErrorBox("SDK 后端已退出", `退出码 ${code}。请重启应用。`);
				},
				onWebError: (message) => {
					void dialog.showMessageBox({
						type: "warning", message: "Web 访问未启动",
						detail: `${message}\n桌面端可继续使用。请在设置中修正 Web 访问配置后重启 Desktop。`,
					});
				},
				onState: (event) => {
					if (desktopWindow.isDestroyed()) return;
					switch (event.type) {
						case "activity": power.activity(taskStatus.update(event.value)); break;
						case "guiConfig": if (event.value.state === "ready") power.configure(event.value.value.preventSleepWhileRunning); break;
						case "selected":
							if (event.session) menu.select(event.session.cwd);
							break;
						case "workspaces": menu.workspaces(event.value); break;
					}
				},
				onReady: () => launches.ready(async (target) => {
					await client.request("action", { sessionId: null, value: await launchAction(target) }, undefined);
					focusWindow();
				}),
			},
		);
		const attend = trackDesktopAttention(window, (value) => client.send({ kind: "attention", value }));
		ipcMain.on("gui:attention", (event, sessionId: unknown) => {
			trusted(event);
			if (sessionId !== null && typeof sessionId !== "string") throw new Error("无效会话标识");
			attend(sessionId);
		});
		for (const kind of ["action", "query"] as const) {
			ipcMain.handle(`gui:${kind}`, (event, value: unknown, submittedAt: unknown) => {
				trusted(event);
				return client.request(kind, value, submittedAt);
			});
		}
		ipcMain.on("gui:subscribe", (event) => {
			trusted(event);
			diagnostics.reset();
			client.send({ kind: "subscribe" });
			attend(null);
		});
		ipcMain.on("gui:received", (event, id: unknown, at: unknown) => {
			trusted(event);
			if (typeof id !== "number" || !Number.isSafeInteger(id) || typeof at !== "number" || !Number.isFinite(at)) throw new Error("无效接收时间");
			diagnostics.received(id, at);
		});
		ipcMain.on("gui:ack", (event, id: unknown, appliedAt: unknown) => {
			trusted(event);
			if (typeof id !== "number" || !Number.isSafeInteger(id)) throw new Error("无效确认序号");
			diagnostics.acknowledge(id, appliedAt);
			client.send({ kind: "ack", id });
		});
		ipcMain.on("gui:unsubscribe", (event) => {
			trusted(event);
			diagnostics.reset();
			client.send({ kind: "unsubscribe" });
		});
		ipcMain.handle("gui:directory", async (event) => {
			trusted(event);
			const result = await dialog.showOpenDialog(desktopWindow, { properties: ["openDirectory"] });
			return result.canceled ? null : (result.filePaths[0] ?? null);
		});
		ipcMain.handle("gui:external", async (event, url: unknown) => {
			trusted(event);
			if (typeof url !== "string") throw new Error("无效 URL");
			await openExternal(url);
		});
		ipcMain.handle("gui:openFile", async (event, cwd: unknown, name: unknown) => {
			trusted(event);
			await openDesktopFile(await desktopFile(cwd, name));
		});
		app.on("window-all-closed", () => app.quit());
		installDesktopShutdown(window, client, diagnostics);
		await window.loadURL(entryUrl);
	}).catch((error: unknown) => {
		dialog.showErrorBox("启动失败", String(error));
		app.quit();
	});
}

if (app.requestSingleInstanceLock()) startDesktop();
else app.quit();
