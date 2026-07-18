import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const mode = process.argv[2];
if (mode !== "tokenizer" && mode !== "math") throw new Error("mode must be tokenizer or math");

const jiti = createJiti(import.meta.url, { moduleCache: false });
const started = performance.now();

if (mode === "tokenizer") {
	const module = await jiti.import(fileURLToPath(new URL("../src/token-counter.ts", import.meta.url)));
	const imported = performance.now();
	const firstO200k = await module.countTextTokens("benchmark English 中文 mixed input", { provider: "openai", modelId: "gpt-5" });
	const firstO200kCompleted = performance.now();
	const warmO200k = await module.countTextTokens("second benchmark input", { provider: "openai", modelId: "gpt-5" });
	const warmO200kCompleted = performance.now();
	const firstCl100k = await module.countTextTokens("benchmark qwen tokenizer", { provider: "dashscope", modelId: "qwen-max" });
	const firstCl100kCompleted = performance.now();
	const warmCl100k = await module.countTextTokens("second qwen input", { provider: "dashscope", modelId: "qwen-max" });
	const warmCl100kCompleted = performance.now();
	if (firstO200k.method !== "o200k_base" || warmO200k.method !== "o200k_base") throw new Error("o200k benchmark used an unexpected tokenizer");
	if (firstCl100k.method !== "cl100k_base" || warmCl100k.method !== "cl100k_base") throw new Error("cl100k benchmark used an unexpected tokenizer");
	writeResult({
		moduleImportMs: imported - started,
		firstO200kMs: firstO200kCompleted - imported,
		warmO200kMs: warmO200kCompleted - firstO200kCompleted,
		firstCl100kMs: firstCl100kCompleted - warmO200kCompleted,
		warmCl100kMs: warmCl100kCompleted - firstCl100kCompleted,
	});
} else {
	await jiti.import(fileURLToPath(new URL("../src/tui/math-markdown.ts", import.meta.url)));
	const markdownImported = performance.now();
	const module = await jiti.import(fileURLToPath(new URL("../src/tui/math-renderer.ts", import.meta.url)));
	const rendererImported = performance.now();
	await module.warmMathRenderer();
	const warmed = performance.now();
	const config = {
		enabled: true,
		display: true,
		inline: "text",
		max_width_cells: 120,
		max_height_cells: 18,
		svg_scale: 2,
		foreground: "#d4d4d4",
	};
	const first = module.renderDisplayMathImage(String.raw`\frac{x^2 + y^2}{\sqrt{z}}`, config);
	const firstCompleted = performance.now();
	const warm = module.renderDisplayMathImage(String.raw`\frac{x^2 + y^2}{\sqrt{z}}`, config);
	const warmCompleted = performance.now();
	if (first === undefined || warm === undefined) throw new Error("math benchmark did not render an image");
	writeResult({
		markdownModuleImportMs: markdownImported - started,
		rendererModuleImportMs: rendererImported - markdownImported,
		fontWarmMs: warmed - rendererImported,
		firstRenderMs: firstCompleted - warmed,
		cachedRenderMs: warmCompleted - firstCompleted,
		rssMb: process.memoryUsage().rss / 1024 / 1024,
	});
}

function writeResult(value) {
	process.stdout.write(JSON.stringify(value));
}
