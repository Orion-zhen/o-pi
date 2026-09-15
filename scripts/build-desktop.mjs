import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as buildUi } from "vite";
import { collectAssets } from "./build/assets.mjs";
import { runtimePlugin } from "./build/plugins.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const appDir = path.join(root, "dist/desktop/app");
await buildUi({ configFile: path.join(root, "vite.gui.config.ts") });
await rm(appDir, { recursive: true, force: true });
await mkdir(appDir, { recursive: true });
await collectAssets(root, path.join(appDir, "resources"), { target: "node" });
const piRoot = new URL("../", import.meta.resolve("@earendil-works/pi-coding-agent"));
for (const [source, filename, format] of [
	[path.join(root, "src/desktop/main.ts"), "main.mjs", "esm"],
	[path.join(root, "src/desktop/preload.ts"), "preload.cjs", "cjs"],
	[path.join(root, "src/desktop/backend.ts"), "backend.mjs", "esm"],
	[fileURLToPath(new URL("dist/utils/image-resize-worker.js", piRoot)), "image-resize-worker.js", "esm"],
]) {
	const result = await Bun.build({
		entrypoints: [source],
		target: "node",
		format,
		define: { PI_BUNDLED_NODE: "true" },
		external: ["electron"],
		minify: true,
		plugins: [runtimePlugin()],
	});
	if (result.outputs.length !== 1) throw new Error(`Unexpected desktop outputs: ${filename}`);
	await writeFile(path.join(appDir, filename), await result.outputs[0].arrayBuffer());
}
await cp(path.join(root, "dist/gui"), path.join(appDir, "ui"), { recursive: true });
const { version } = JSON.parse(await readFile(new URL("package.json", piRoot), "utf8"));
await writeFile(
	path.join(appDir, "package.json"),
	JSON.stringify(
		{
			name: "o-pi-desktop",
			productName: "o-pi",
			version,
			type: "module",
			main: "main.mjs",
			description: "o-pi desktop SDK host",
			author: "Orion",
			license: "MIT",
		},
		null,
		2,
	),
);
console.log(`Built desktop app: ${appDir}`);
if (!process.argv.includes("--dir")) {
	const { build } = await import("electron-builder");
	const electronVersion = JSON.parse(
		await readFile(path.join(root, "node_modules/electron/package.json"), "utf8"),
	).version;
	await build({
		projectDir: appDir,
		config: {
			appId: "dev.orion.opi",
			productName: "o-pi",
			electronVersion,
			asar: false,
			npmRebuild: false,
			directories: { output: path.join(root, "dist/desktop/release") },
			files: ["**/*"],
			linux: { target: ["AppImage"], category: "Development" },
			mac: { target: ["dmg"], category: "public.app-category.developer-tools", identity: null },
			win: { target: ["nsis"] },
		},
	});
}
