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
import type { GuiEvent } from "../gui/contract.ts";
import { GUI_BACKGROUNDS } from "../gui/theme-base.ts";
import { BackendClient } from "./backend-client.ts";
import { resolveShellEnvironment } from "./shell-environment.ts";
import { forkDesktopWorker } from "./worker-services.ts";
import { DesktopDiagnostics } from "./diagnostics.ts";
import { installDesktopAppearance } from "./appearance.ts";
import { fileResourceResponse, type FileResource } from "../gui/host/file-resource.ts";

protocol.registerSchemesAsPrivileged([
	{ scheme: "opi", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
const directory = path.dirname(fileURLToPath(import.meta.url));
const icon = path.join(directory, "icons", process.platform === "win32" ? "icon.ico" : process.platform === "darwin" ? "icon-macos.png" : "icon.png");
if (process.platform === "win32") app.setAppUserModelId("dev.orion.opi");
const entryUrl = "opi://app/index.html";
let window: BrowserWindow | undefined;
let backend: BackendClient | undefined;

function trusted(event: IpcMainInvokeEvent): void {
	if (
		!window ||
		event.sender !== window.webContents ||
		event.senderFrame !== window.webContents.mainFrame ||
		event.senderFrame.url !== entryUrl
	)
		throw new Error("Untrusted renderer");
}
async function openExternal(url: string): Promise<void> {
	if (!["https:", "http:", "mailto:"].includes(new URL(url).protocol)) throw new Error("不允许打开此协议。");
	return shell.openExternal(url);
}

async function saveDownload(event: Extract<GuiEvent, { type: "download" }>): Promise<void> {
	const result = await dialog.showSaveDialog({
		defaultPath: path.join(app.getPath("downloads"), path.basename(event.name)),
	});
	if (result.canceled || !result.filePath) return;
	await writeFile(result.filePath, event.content, { mode: 0o600 });
	backend?.send({ kind: "notice", text: `已导出: ${result.filePath}` });
}

void app
	.whenReady()
	.then(async () => {
		const diagnostics = new DesktopDiagnostics(path.join(app.getPath("logs"), "gui-timing.jsonl"));
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
					if (!backend) throw new Error("SDK 后端不可用。");
					const resource = await backend.request("resource", url.searchParams.get("token"), undefined) as FileResource;
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
		window = new BrowserWindow({
			width: 1200,
			height: 820,
			minWidth: 420,
			minHeight: 500,
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
		const setAppearance = installDesktopAppearance(window);
		ipcMain.handle("gui:appearance", (event, value: unknown) => {
			trusted(event);
			return setAppearance(value);
		});
		window.removeMenu();
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
			(delivery, at) => {
				const events = delivery.events.filter((event) => {
					if (event.type === "close") { app.quit(); return false; }
					if (event.type !== "download") return true;
					void saveDownload(event).catch((error: unknown) => dialog.showErrorBox("导出失败", String(error)));
					return false;
				});
				if (window && !window.isDestroyed()) {
					const traced = diagnostics.delivery(delivery, at);
					window.webContents.send("gui:event", { ...delivery, events }, traced);
				}
			},
			(code, stopping) => {
				if (stopping) app.quit();
				else dialog.showErrorBox("SDK 后端已退出", `退出码 ${code}。请重启应用。`);
			},
			diagnostics,
			(message) => {
				void dialog.showMessageBox({
					type: "warning", message: "Web 访问未启动",
					detail: `${message}\n桌面端可继续使用。请在设置中修正 Web 访问配置后重启 Desktop。`,
				});
			},
		);
		backend = client;
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
			const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
			return result.canceled ? null : (result.filePaths[0] ?? null);
		});
		ipcMain.handle("gui:external", async (event, url: unknown) => {
			trusted(event);
			if (typeof url !== "string") throw new Error("无效 URL");
			await openExternal(url);
		});
		app.on("window-all-closed", () => app.quit());
		app.on("before-quit", (event) => {
			if (client.stop()) event.preventDefault();
			else if (!diagnostics.closed) {
				event.preventDefault();
				void diagnostics.close().then(() => app.quit());
			}
		});
		await window.loadURL(entryUrl);
	})
	.catch((error: unknown) => {
		dialog.showErrorBox("启动失败", String(error));
		app.quit();
	});
