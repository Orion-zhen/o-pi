import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
	args: process.argv.slice(2),
	options: { dir: { type: "boolean" }, help: { type: "boolean" } },
	allowPositionals: true,
});
if (values.help) {
	console.log("bun scripts/build.mjs [tui web desktop] [--dir]\n默认构建三端。--dir 只生成桌面应用目录，不制作安装包。");
	process.exit(0);
}
const targets = positionals.length === 0 ? ["tui", "web", "desktop"] : [...new Set(positionals)];
for (const target of targets) {
	if (!["tui", "web", "desktop"].includes(target)) throw new Error(`未知构建目标: ${target}`);
}
if (values.dir && !targets.includes("desktop")) throw new Error("--dir 需要 desktop 目标。");

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
		if (target === "desktop") {
			const { buildDesktop } = await import("./build/desktop.mjs");
			await buildDesktop({ root, ui, directoryOnly: values.dir === true });
		} else {
			const { buildBinary } = await import("./build/bun.mjs");
			await buildBinary({ root, target, staging: path.join(staging, target), ui });
		}
	}
} finally {
	await rm(staging, { recursive: true, force: true });
}
