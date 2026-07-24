import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { loadTypeScript } from "../benchmark/loader.mjs";

const args = process.argv.slice(2);
const size = readSize(args);
const scenario = readScenario(args);
const started = performance.now();
const parser = await loadTypeScript("src/code-index/parser.ts");
const loaded = performance.now();
const source = fixture(size, scenario);
const files = ["fixture.ts", "fixture.tsx", "fixture.mts", "fixture.cts"];

const coldStarted = performance.now();
const cold = parser.analyzeCodeFile(files[0], source);
const coldParseMs = performance.now() - coldStarted;
const warmStarted = performance.now();
const warm = parser.analyzeCodeFile(files[0], source);
const warmParseMs = performance.now() - warmStarted;
const localStarted = performance.now();
const local = files.map((file) => parser.analyzeCodeFile(file, source));
const localBatchMs = performance.now() - localStarted;
const workerStarted = performance.now();
const workerBatch = await runWorker(files, source);
const workerBatchMs = performance.now() - workerStarted;

const oracle = {
	units: cold.index.units.map((unit) => [unit.kind, unit.name, unit.startByte, unit.endByte]),
	imports: cold.imports.map((item) => [item.specifier, item.startByte, item.endByte]),
	warmUnits: warm.index.units.length,
	workerUnits: workerBatch.reduce((total, result) => total + result.units, 0),
};
console.log(JSON.stringify({
	scenario,
	size,
	loaderMs: loaded - started,
	coldParseMs,
	warmParseMs,
	localBatchMs,
	workerBatchMs,
	rssMb: process.memoryUsage().rss / 1024 / 1024,
	oracleDigest: createHash("sha256").update(JSON.stringify(oracle)).digest("hex"),
	counts: { units: local.reduce((total, result) => total + result.index.units.length, 0), imports: cold.imports.length },
}));

function runWorker(paths, text) {
	return new Promise((resolve, reject) => {
		const child = new Worker(new URL("./bench-code-index-task-worker.mjs", import.meta.url));
		child.once("message", (value) => {
			void child.terminate();
			resolve(value);
		});
		child.once("error", reject);
		child.postMessage({ paths, text });
	});
}

function fixture(declarations, scenario) {
	const count = scenario === "import-heavy" ? declarations : Math.max(1, Math.floor(declarations / 100));
	const imports = Array.from({ length: count }, (_, index) => `import { value${index} } from "./dep-${index}";`).join("\n");
	const declaration = (index) => `export const value${index} = ${index};`;
	const body = scenario === "long-line"
		? Array.from({ length: declarations }, (_, index) => declaration(index)).join(" ")
		: Array.from({ length: declarations }, (_, index) => declaration(index)).join("\n");
	const unicode = scenario === "unicode" ? `const label = "中文 emoji 🚀";\n` : "";
	return `${imports}\n${body}\n${unicode}`;
}

function readSize(args) {
	const value = Number(args.find((arg) => arg.startsWith("--size="))?.slice(7) ?? 4000);
	if (!Number.isInteger(value) || value < 2 || value > 100_000) throw new Error("--size must be an integer between 2 and 100000");
	return value;
}

function readScenario(args) {
	const value = args.find((arg) => arg.startsWith("--scenario="))?.slice(11) ?? "dense";
	if (!["ascii", "unicode", "dense", "long-line", "import-heavy"].includes(value)) throw new Error(`unknown code-index scenario: ${value}`);
	return value;
}
