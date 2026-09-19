import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectAssets } from "./assets.mjs";
import { runtimePlugin } from "./plugins.mjs";

export async function buildDesktop({ root, ui, directoryOnly }) {
	const output = path.join(root, "dist/desktop");
	const appDir = path.join(output, "app");
	await rm(output, { recursive: true, force: true });
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
	await cp(ui, path.join(appDir, "ui"), { recursive: true });
	await cp(path.join(root, "assets/icons"), path.join(appDir, "icons"), { recursive: true });
	const { version } = JSON.parse(await readFile(new URL("package.json", piRoot), "utf8"));
	await writeFile(
		path.join(appDir, "package.json"),
		JSON.stringify(
			{
				name: "opi-desktop",
				productName: "opi-desktop",
				desktopName: "opi-desktop.desktop",
				version,
				type: "module",
				main: "main.mjs",
				description: "opi-desktop SDK host",
				author: "Orion",
				license: "AGPL-3.0-only",
			},
			null,
			2,
		),
	);
	console.log(`Built desktop app: ${appDir}`);
	if (directoryOnly) return;
	const { build } = await import("electron-builder");
	const electronVersion = JSON.parse(
		await readFile(path.join(root, "node_modules/electron/package.json"), "utf8"),
	).version;
	await build({
		projectDir: appDir,
		config: {
			appId: "dev.orion.opi",
			productName: "opi-desktop",
			executableName: "opi-desktop",
			artifactName: "opi-desktop.${ext}",
			electronVersion,
			asar: true,
			asarUnpack: ["backend.mjs", "image-resize-worker.js", "resources/**/*"],
			npmRebuild: false,
			directories: { output: path.join(output, "release") },
			files: ["**/*"],
			linux: { target: ["AppImage"], category: "Development", icon: "icons/linux", syncDesktopName: true },
			mac: { target: ["dmg"], category: "public.app-category.developer-tools", identity: null, icon: "icons/icon.icns" },
			win: { target: ["nsis"], icon: "icons/icon.ico" },
		},
	});
}
