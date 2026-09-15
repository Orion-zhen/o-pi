import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TREE_SITTER_LANGUAGES } from "../../src/harness/syntax-tree/grammars.ts";
import { runtimePlugin } from "./plugins.mjs";

const require = createRequire(import.meta.url);
const piRoot = fileURLToPath(new URL("../", import.meta.resolve("@earendil-works/pi-coding-agent")));
export async function collectAssets(root, staging, { target = "bun", extra = [] } = {}) {
	const files = [];
	async function add(source, destination) {
		const metadata = await stat(source);
		if (metadata.isDirectory()) {
			for (const name of (await readdir(source)).sort()) await add(path.join(source, name), `${destination}/${name}`);
			return;
		}
		const target = path.join(staging, destination);
		await mkdir(path.dirname(target), { recursive: true });
		await copyFile(source, target);
		files.push({ path: destination, source: target, executable: (metadata.mode & 0o111) !== 0 });
	}
	for (const directory of ["defaults", "schemas"]) await add(path.join(root, "agent", directory), `agent/${directory}`);
	for (const name of ["package.json", "README.md", "LICENSE"]) await add(path.join(root, name), name);
	await add(path.join(root, "docs"), "docs");
	for (const name of ["package.json", "README.md", "CHANGELOG.md", "docs", "examples"]) await add(path.join(piRoot, name), `pi/${name}`);
	await add(path.join(piRoot, "dist/modes/interactive/theme"), target === "node" ? "pi/dist/modes/interactive/theme" : "pi/theme");
	await add(path.join(piRoot, "dist/modes/interactive/assets"), target === "node" ? "pi/dist/modes/interactive/assets" : "pi/assets");
	await add(path.join(piRoot, "dist/core/export-html"), target === "node" ? "pi/dist/core/export-html" : "pi/export-html");
	const wasmSpecs = new Set(["web-tree-sitter/web-tree-sitter.wasm", ...Object.values(TREE_SITTER_LANGUAGES).map(({ grammar }) => grammar)]);
	for (const spec of wasmSpecs) await add(require.resolve(spec), `wasm/${spec}`);
	await add(require.resolve("@silvia-odwyer/photon-node/photon_rs_bg.wasm"), "wasm/photon_rs_bg.wasm");
	for (const directory of ["cmaps", "standard_fonts", "wasm"]) await add(path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), directory), `pdf/${directory}`);
	await add(require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"), "pdf/pdf.worker.mjs");
	await add(path.join(path.dirname(require.resolve("node-notifier")), "vendor"), "notifier/vendor");

	const libc = process.platform === "linux" ? (process.report.getReport().header.glibcVersionRuntime ? "gnu" : "musl") : undefined;
	const suffix = [process.platform, process.arch, libc, ...(process.platform === "win32" ? ["msvc"] : [])].filter(Boolean).join("-");
	for (const [name, spec] of [
		["canvas", `@napi-rs/canvas-${suffix}`],
		["resvg", `@resvg/resvg-js-${suffix}`],
	]) await add(require.resolve(spec), `native/${name}.node`);

	for (const [name, entry] of [
		["parser-worker", path.join(root, "src/harness/file-tools/grep/parser-worker.ts")],
	]) {
		const output = path.join(staging, "workers", `${name}.mjs`);
		const result = await Bun.build({ entrypoints: [entry], target, format: "esm", minify: true, plugins: [runtimePlugin()] });
		if (result.outputs.length !== 1) throw new Error(`Unexpected worker outputs: ${name}`);
		await mkdir(path.dirname(output), { recursive: true });
		await writeFile(output, await result.outputs[0].arrayBuffer());
		files.push({ path: `workers/${name}.mjs`, source: output, executable: false });
	}
	for (const [source, destination] of extra) await add(source, destination);
	files.sort((a, b) => a.path.localeCompare(b.path, "en"));
	const hash = createHash("sha256");
	for (const file of files) hash.update(file.path).update(String(file.executable)).update(await readFile(file.source));
	return { id: hash.digest("hex"), files };
}

export function assetModule({ id, files }) {
	return files.map((file, index) => `import asset${index} from ${JSON.stringify(file.source)} with { type: "file" };`).join("\n")
		+ `\nexport const id = ${JSON.stringify(id)};\nexport const assets = [\n`
		+ files.map((file, index) => `{ path: ${JSON.stringify(file.path)}, source: asset${index}, executable: ${file.executable} }`).join(",\n")
		+ "\n];\n";
}
