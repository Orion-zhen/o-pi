import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assetModule, collectAssets } from "./assets.mjs";
import { runtimePlugin } from "./plugins.mjs";

export async function buildBinary({ root, target, staging, ui }) {
	const output = path.join(root, "dist", target);
	await rm(output, { recursive: true, force: true });
	await mkdir(output, { recursive: true });
	const resources = await collectAssets(root, staging, { extra: target === "web" ? [[ui, "gui"]] : [] });
	const generated = path.join(staging, "assets.ts");
	await writeFile(generated, assetModule(resources));
	const entry = path.join(staging, "entry.ts");
	const piRoot = new URL("../", import.meta.resolve("@earendil-works/pi-coding-agent"));
	await writeFile(entry, `import ${JSON.stringify(path.join(root, "src/harness/runtime/binary.ts"))};
import wasm from ${JSON.stringify(fileURLToPath(import.meta.resolve("quickjs-wasi/quickjs.wasm")))} with { type: "file" };
const { setEmbeddedQuickJSWasmPath } = await import(${JSON.stringify(fileURLToPath(new URL("dist/config.js", piRoot)))});
setEmbeddedQuickJSWasmPath(wasm);
await import(${JSON.stringify(path.join(root, "src", target, "binary.ts"))});\n`);
	// Pi 的 Bun 发行入口约定这些 worker 路径，不改写上游实现。
	const workers = [];
	for (const relative of ["utils/image-resize-worker", "extensions/codemode/worker"]) {
		const worker = path.join(staging, `src/${relative}.ts`);
		await mkdir(path.dirname(worker), { recursive: true });
		await writeFile(worker, `import ${JSON.stringify(fileURLToPath(new URL(`dist/${relative}.js`, piRoot)))};\n`);
		workers.push(worker);
	}
	const name = target === "tui" ? "opi" : "opi-web";
	const result = await Bun.build({
		entrypoints: [entry, ...workers],
		root: staging,
		compile: {
			outfile: path.join(output, process.platform === "win32" ? `${name}.exe` : name),
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
}
