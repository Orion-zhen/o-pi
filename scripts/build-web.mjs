import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as buildUi } from "vite";
import { assetModule, collectAssets } from "./build/assets.mjs";
import { runtimePlugin } from "./build/plugins.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = path.join(root, "dist");
await buildUi({ configFile: path.join(root, "vite.gui.config.ts") });
await mkdir(dist, { recursive: true });
const staging = await mkdtemp(path.join(dist, ".web-build-"));
try {
	const resources = await collectAssets(root, staging, { extra: [[path.join(dist, "gui"), "gui"]] });
	const generated = path.join(staging, "assets.ts");
	await writeFile(generated, assetModule(resources));
	const entry = path.join(staging, "entry.ts");
	await writeFile(entry, `import ${JSON.stringify(path.join(root, "src/web/binary.ts"))};\n`);
	const worker = path.join(staging, "src/utils/image-resize-worker.ts");
	await mkdir(path.dirname(worker), { recursive: true });
	const piRoot = new URL("../", import.meta.resolve("@earendil-works/pi-coding-agent"));
	await writeFile(
		worker,
		`import ${JSON.stringify(fileURLToPath(new URL("dist/utils/image-resize-worker.js", piRoot)))};\n`,
	);
	const result = await Bun.build({
		entrypoints: [entry, worker],
		root: staging,
		compile: {
			outfile: path.join(dist, process.platform === "win32" ? "opi-web.exe" : "opi-web"),
			autoloadDotenv: false,
			autoloadBunfig: false,
		},
		format: "esm",
		minify: true,
		bytecode: true,
		sourcemap: "linked",
		plugins: [
			runtimePlugin(),
			{
				name: "opi-web-assets",
				setup(build) {
					build.onResolve({ filter: /^opi:assets$/ }, () => ({ path: generated }));
				},
			},
		],
	});
	console.log(`Built ${result.outputs[0].path}`);
} finally {
	await rm(staging, { recursive: true, force: true });
}
