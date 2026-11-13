import { app } from "electron";
import path from "node:path";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { GuiAction } from "../gui/shared/protocol/actions.ts";

type Navigation = Extract<GuiAction, { action: "workspace" | "openSession" }>;
type DesktopLaunch = Navigation | { file: string };
export const desktopScheme = "opi-desktop";

export function parseLaunchUrl(value: string): Navigation {
	const url = new URL(value);
	if (url.protocol !== `${desktopScheme}:` || url.username || url.password || url.port || url.hash || (url.pathname !== "" && url.pathname !== "/"))
		throw new Error("无效 Desktop 链接。");
	const entries = [...url.searchParams];
	const entry = entries[0];
	if (entries.length !== 1 || !entry || !entry[1] || entry[1].includes("\0")) throw new Error("Desktop 链接只接受一个目标。");
	const [key, target] = entry;
	if (url.hostname === "session" && key === "id") return { action: "openSession", id: target };
	if ((url.hostname === "workspace" || url.hostname === "session") && key === "path" && path.isAbsolute(target))
		return url.hostname === "workspace" ? { action: "workspace", path: target } : { action: "openSession", path: target };
	throw new Error("Desktop 链接仅支持工作区绝对路径、会话绝对路径或会话 ID。");
}

function launchArguments(argv: string[], cwd: string): string[] {
	const args = argv.slice(1);
	if (!process.defaultApp) return args;
	const index = args.findIndex((arg) => !arg.startsWith("-") && path.resolve(cwd, arg) === app.getAppPath());
	if (index === -1) throw new Error("无法定位 Desktop 应用入口。");
	args.splice(index, 1);
	return args;
}

function parseLaunchArguments(args: string[], cwd: string): DesktopLaunch[] {
	const targets: DesktopLaunch[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (!arg) continue;
		if (arg.toLowerCase().startsWith(`${desktopScheme}:`)) targets.push(parseLaunchUrl(arg));
		else if (arg.startsWith("file://")) targets.push({ file: fileURLToPath(arg) });
		else if (path.isAbsolute(arg)) targets.push({ file: arg });
		else if (arg === "--workspace" || arg === "--session") {
			const value = args[++index];
			if (!value || value.startsWith("--") || value.includes("\0")) throw new Error(`${arg} 需要路径。`);
			const target = path.resolve(cwd, value);
			targets.push(arg === "--workspace" ? { action: "workspace", path: target } : { action: "openSession", path: target });
		}
	}
	return targets;
}

/** 后端就绪时绑定导航处理函数，所有入口串行执行。 */
export function installDesktopLaunch(focus: () => void, report: (error: unknown) => void) {
	const ready = Promise.withResolvers<(action: Navigation) => Promise<void>>();
	let chain = Promise.resolve();
	const enqueue = (target: DesktopLaunch) => {
		chain = chain.then(async () => {
			const open = await ready.promise;
			const action: Navigation = "file" in target
				? (await stat(target.file)).isDirectory()
					? { action: "workspace", path: target.file }
					: { action: "openSession", path: target.file }
				: target;
			await open(action);
		}).catch(report);
	};
	const receive = (parse: () => DesktopLaunch[]) => {
		try { for (const target of parse()) enqueue(target); }
		catch (error) { void app.whenReady().then(() => report(error)); }
	};
	app.on("open-url", (event, url) => { event.preventDefault(); receive(() => [parseLaunchUrl(url)]); focus(); });
	app.on("open-file", (event, file) => { event.preventDefault(); enqueue({ file }); focus(); });
	app.on("second-instance", (_event, argv, cwd) => {
		receive(() => parseLaunchArguments(launchArguments(argv, cwd), cwd));
		focus();
	});
	app.on("activate", focus);
	receive(() => parseLaunchArguments(launchArguments(process.argv, process.cwd()), process.cwd()));
	return { enqueue, ready: ready.resolve };
}
