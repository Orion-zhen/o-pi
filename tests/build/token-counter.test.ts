import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { useTempDir } from "../helpers/lifecycle.ts";

const exec = promisify(execFile);
const temp = useTempDir("opi-token-counter-build-");
const source = fileURLToPath(new URL("../../src/harness/token-counter.ts", import.meta.url));

it.each(["binary", "node"] as const)("%s 产物在无 node_modules 的目录中冷启动分词", async (target) => {
	const entry = path.join(temp.path, "entry.ts");
	const output = path.join(temp.path, target === "node" ? "counter.mjs" : process.platform === "win32" ? "counter.exe" : "counter");
	await writeFile(entry, `import { countTextTokens, countTextTokensSync } from ${JSON.stringify(source)};
try {
	const results = [];
	for (const modelId of ["gpt-5", "gpt-4", "gpt-oss-120b"]) {
		const scope = { modelId };
		const first = process.argv[2] === "async-first"
			? await countTextTokens("hello world", scope)
			: countTextTokensSync("hello world", scope);
		results.push([first, countTextTokensSync("hello world", scope), await countTextTokens("hello world", scope)]);
	}
	console.log(JSON.stringify(results));
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
`);
	const options = { cwd: temp.path, env: { ...process.env, NODE_PATH: "" }, timeout: 30_000, windowsHide: true };
	await exec("bun", [
		"build", entry, "--outfile", output, "--format=esm", "--minify", "--sourcemap=linked",
		...(target === "binary" ? ["--compile", "--bytecode"] : ["--target=node"]),
	], options);

	for (const mode of ["sync-first", "async-first"]) {
		const { stdout, stderr } = await exec(
			target === "binary" ? output : process.execPath,
			target === "binary" ? [mode] : [output, mode],
			options,
		);
		expect(stderr).toBe("");
		expect(JSON.parse(stdout)).toMatchObject(["o200k_base", "cl100k_base", "o200k_harmony"].map((method) =>
			Array.from({ length: 3 }, () => ({ method, tokens: 2, confidence: "high" })),
		));
	}
}, 60_000);
