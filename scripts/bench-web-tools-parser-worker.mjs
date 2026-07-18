import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const entry = fileURLToPath(new URL("../src/web-tools/duckduckgo-html.ts", import.meta.url));
const fixture = readFileSync(fileURLToPath(new URL("../tests/web-tools/fixtures/websearch/results.html", import.meta.url)), "utf8");
const started = performance.now();
const module = await createJiti(import.meta.url, { moduleCache: false }).import(entry);
const imported = performance.now();
module.parseDuckDuckGoHtml(fixture);
const firstCompleted = performance.now();
module.parseDuckDuckGoHtml(fixture);
const warmCompleted = performance.now();
console.log(JSON.stringify({
	importMs: imported - started,
	firstParseMs: firstCompleted - imported,
	warmParseMs: warmCompleted - firstCompleted,
}));
