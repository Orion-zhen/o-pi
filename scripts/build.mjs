import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assetModule, collectAssets } from "./build/assets.mjs";
import { runtimePlugin } from "./build/plugins.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = path.join(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
const staging = await mkdtemp(path.join(dist, ".build-"));
try {
	const resources = await collectAssets(root, staging);
	const generated = path.join(staging, "assets.ts");
	await writeFile(generated, assetModule(resources));
	const entry = path.join(staging, "entry.ts");
	await writeFile(entry, `import ${JSON.stringify(path.join(root, "src/binary.ts"))};\n`);
	// Pi 的 Bun 发行入口约定此 worker 路径，不改写上游实现。
	const worker = path.join(staging, "src/utils/image-resize-worker.ts");
	await mkdir(path.dirname(worker), { recursive: true });
	const piRoot = new URL("../", import.meta.resolve("@earendil-works/pi-coding-agent"));
	await writeFile(worker, `import ${JSON.stringify(fileURLToPath(new URL("dist/utils/image-resize-worker.js", piRoot)))};\n`);
	const result = await Bun.build({
		entrypoints: [entry, worker],
		root: staging,
		compile: {
			outfile: path.join(dist, process.platform === "win32" ? "opi.exe" : "opi"),
			autoloadDotenv: false,
			autoloadBunfig: false,
		},
		format: "esm",
		minify: true,
		bytecode: true,
		sourcemap: "linked",
		plugins: [runtimePlugin(), {
			name: "opi-asset-manifest",
			setup(build) {
				build.onResolve({ filter: /^opi:assets$/ }, () => ({ path: generated }));
			},
		}],
	});
	console.log(`Built ${result.outputs[0].path} (${resources.files.length} embedded assets)`);
} finally {
	await rm(staging, { recursive: true, force: true });
}
