import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { hostPlatform, resolvePlatform, supportedPlatforms } from "./build/platform.mjs";

const { values, positionals } = parseArgs({
	args: process.argv.slice(2),
	options: { dir: { type: "boolean" }, help: { type: "boolean" }, target: { type: "string" } },
	allowPositionals: true,
});
if (values.help) {
	console.log(`bun scripts/build.mjs [tui web desktop] [--target <platform>] [--dir]
默认构建三端。--target 支持三端，未指定应用时构建 TUI 和 Web。
平台: ${supportedPlatforms.join(", ")}
--dir 只生成桌面应用目录，不制作安装包。`);
	process.exit(0);
}
const targets = positionals.length === 0 ? (values.target === undefined ? ["tui", "web", "desktop"] : ["tui", "web"]) : [...new Set(positionals)];
for (const target of targets) {
	if (!["tui", "web", "desktop"].includes(target)) throw new Error(`未知构建目标: ${target}`);
}
if (values.dir && !targets.includes("desktop")) throw new Error("--dir 需要 desktop 目标。");
const platform = values.target === undefined ? hostPlatform() : resolvePlatform(values.target);
if (targets.includes("desktop")) {
	if (platform.libc === "musl") throw new Error("Electron 不支持 Linux musl，请使用 linux-x64 或 linux-arm64。");
	if (!values.dir && platform.os === "darwin" && process.platform !== "darwin") {
		throw new Error("macOS 桌面安装包需在 macOS 上构建。--dir 可只生成应用目录。");
	}
	if (!values.dir && platform.os === "linux" && process.platform === "win32") {
		throw new Error("Linux 桌面安装包需在 Linux 或 macOS 上构建。");
	}
}

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = path.join(root, "dist");
await mkdir(dist, { recursive: true });
const staging = await mkdtemp(path.join(dist, ".build-"));
try {
	let ui;
	for (const target of targets) {
		if (target !== "tui" && ui === undefined) {
			ui = path.join(staging, "gui");
			const { build } = await import("vite");
			await build({ configFile: path.join(root, "vite.gui.config.ts"), build: { outDir: ui } });
		}
		const output = path.join(dist, ...(values.target === undefined ? [] : [platform.name]), target);
		if (target === "desktop") {
			const { buildDesktop } = await import("./build/desktop.mjs");
			await buildDesktop({ root, ui, platform, output, directoryOnly: values.dir === true });
		} else {
			const { buildBinary } = await import("./build/bun.mjs");
			await buildBinary({ root, target, staging: path.join(staging, target), ui, platform, output });
		}
	}
} finally {
	await rm(staging, { recursive: true, force: true });
}
