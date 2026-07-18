import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const root = fileURLToPath(new URL("..", import.meta.url));
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { findWorkspaceFiles } = await jiti.import(fileURLToPath(new URL("../src/file-tools/tools/find.ts", import.meta.url)));
const { grepWorkspaceFiles } = await jiti.import(fileURLToPath(new URL("../src/file-tools/tools/grep.ts", import.meta.url)));
const { clearGrepIndexForTests } = await jiti.import(fileURLToPath(new URL("../src/file-tools/grep/indexer.ts", import.meta.url)));
const { defaultIgnoreEngine } = await jiti.import(fileURLToPath(new URL("../src/file-tools/ignore/ignore-engine.ts", import.meta.url)));

defaultIgnoreEngine.invalidate();
clearGrepIndexForTests();
const coldFindMs = await measure(() => findWorkspaceFiles(root, { query: "file tools config" }));
const warmFindMs = await measure(() => findWorkspaceFiles(root, { query: "file tools config" }));
const coldGrepMs = await measure(() => grepWorkspaceFiles(root, { query: "createRetryableLoader", match: "literal" }));
const warmGrepMs = await measure(() => grepWorkspaceFiles(root, { query: "createRetryableLoader", match: "literal" }));

defaultIgnoreEngine.invalidate();
clearGrepIndexForTests();
const concurrentGrepMs = await measure(() => Promise.all([
	grepWorkspaceFiles(root, { query: "createRetryableLoader", match: "literal" }),
	grepWorkspaceFiles(root, { query: "createLazyRepoMap", match: "literal" }),
]));

console.log(JSON.stringify({ coldFindMs, warmFindMs, coldGrepMs, warmGrepMs, concurrentGrepMs }));

async function measure(operation) {
	const started = performance.now();
	const result = await operation();
	assertSuccess(result);
	return performance.now() - started;
}

function assertSuccess(result) {
	const values = Array.isArray(result) ? result : [result];
	if (values.some((value) => value?.status === "failed")) throw new Error("search benchmark operation failed");
}
