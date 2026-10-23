import { app } from "electron";
import path from "node:path";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { GuiAction } from "../gui/shared/protocol/actions.ts";

type DesktopLaunch = { kind: "workspace" | "session" | "file"; path: string } | { kind: "sessionId"; id: string };
export const desktopScheme = "opi-desktop";

export function parseLaunchUrl(value: string): DesktopLaunch {
	const url = new URL(value);
	if (url.protocol !== `${desktopScheme}:` || url.username || url.password || url.port || url.hash || (url.pathname !== "" && url.pathname !== "/"))
		throw new Error("无效 Desktop 链接。");
	const entries = [...url.searchParams];
	const entry = entries[0];
	if (entries.length !== 1 || !entry || !entry[1] || entry[1].includes("\0")) throw new Error("Desktop 链接只接受一个目标。");
	const [key, target] = entry;
	if (url.hostname === "session" && key === "id") return { kind: "sessionId", id: target };
	if ((url.hostname === "workspace" || url.hostname === "session") && key === "path" && path.isAbsolute(target))
		return { kind: url.hostname, path: target };
	throw new Error("Desktop 链接仅支持工作区绝对路径、会话绝对路径或会话 ID。");
}

function parseLaunchArguments(args: string[], cwd: string): DesktopLaunch[] {
	const targets: DesktopLaunch[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (!arg) continue;
		if (arg.toLowerCase().startsWith(`${desktopScheme}:`)) targets.push(parseLaunchUrl(arg));
		else if (arg.startsWith("file://")) targets.push({ kind: "file", path: fileURLToPath(arg) });
		else if (path.isAbsolute(arg)) targets.push({ kind: "file", path: arg });
		else if (arg === "--workspace" || arg === "--session") {
			const value = args[++index];
			if (!value || value.startsWith("--") || value.includes("\0")) throw new Error(`${arg} 需要路径。`);
			targets.push({ kind: arg === "--workspace" ? "workspace" : "session", path: path.resolve(cwd, value) });
		}
	}
	return targets;
}

export async function launchAction(target: DesktopLaunch): Promise<Extract<GuiAction, { action: "workspace" | "openSession" }>> {
	switch (target.kind) {
		case "sessionId": return { action: "openSession", id: target.id };
		case "workspace": return { action: "workspace", path: target.path };
		case "session": return { action: "openSession", path: target.path };
		case "file": return (await stat(target.path)).isDirectory()
			? { action: "workspace", path: target.path } : { action: "openSession", path: target.path };
	}
}

/** 后端就绪时绑定导航处理函数，所有入口串行执行。 */
export function installDesktopLaunch(focus: () => void, report: (error: unknown) => void) {
	const ready = Promise.withResolvers<(target: DesktopLaunch) => Promise<void>>();
	let chain = Promise.resolve();
	const enqueue = (target: DesktopLaunch) => { chain = chain.then(async () => (await ready.promise)(target)).catch(report); };
	const receive = (parse: () => DesktopLaunch[]) => {
		try { for (const target of parse()) enqueue(target); }
		catch (error) { void app.whenReady().then(() => report(error)); }
	};
	app.on("open-url", (event, url) => { event.preventDefault(); receive(() => [parseLaunchUrl(url)]); focus(); });
	app.on("open-file", (event, file) => { event.preventDefault(); enqueue({ kind: "file", path: file }); focus(); });
	app.on("second-instance", (_event, argv, cwd) => {
		receive(() => parseLaunchArguments(argv.slice(app.isPackaged ? 1 : 2), cwd));
		focus();
	});
	app.on("activate", focus);
	receive(() => parseLaunchArguments(process.argv.slice(app.isPackaged ? 1 : 2), process.cwd()));
	return { enqueue, ready: ready.resolve };
}
