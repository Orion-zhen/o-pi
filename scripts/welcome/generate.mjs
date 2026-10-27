import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { welcomeAssets } from "./svg.ts";

const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== "--check")) throw new Error("用法: bun scripts/welcome/generate.mjs [--check]");
const check = args[0] === "--check";
const source = new URL("../../assets/welcome/", import.meta.url);
const output = new URL("../../src/gui/frontend/app/welcome/art/", import.meta.url);
const [character, reveal] = await Promise.all(["character.svg", "reveal.svg"].map((name) => readFile(new URL(name, source), "utf8")));
const files = welcomeAssets(character, reveal);
if (!check) await mkdir(output, { recursive: true });
const extra = (await readdir(output)).filter((name) => name.endsWith(".json") && !files.has(name));
if (extra.length) throw new Error(`存在未生成的资产: ${extra.join(", ")}`);
for (const [name, content] of files) {
	const path = new URL(name, output);
	if (check) {
		if (await readFile(path, "utf8") !== content) throw new Error(`${name} 与 SVG 不一致，请运行 bun run generate:welcome`);
	} else await writeFile(path, content);
}
console.log(`欢迎页资产${check ? "校验" : "生成"}完成: ${files.size} 个 JSON`);
