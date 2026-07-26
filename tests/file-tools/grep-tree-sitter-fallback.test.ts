import { writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

vi.mock("../../src/code-index/tree-sitter-loader.js", () => ({
	DEFAULT_PARSE_TIMEOUT_MICROS: 250_000,
	disposeTreeSitterParsers() {},
	loadTreeSitterParser: async () => ({ failure: { code: "RUNTIME_UNAVAILABLE", message: "simulated runtime failure" } }),
}));

import { clearGrepTestRuntime as clearGrepIndex } from "../helpers/grep-tool.js";
import { grepWorkspaceFiles } from "../helpers/grep-tool.js";

const workspaceTemp = useTempDir("o-pi-grep-no-tree-sitter-");
const configTemp = useTempDir("o-pi-grep-no-tree-sitter-config-");
preserveEnv("PI_FILE_TOOLS_CONFIG");

beforeEach(async () => {
	clearGrepIndex();
	const configPath = path.join(configTemp.path, "file-tools.jsonc");
	process.env["PI_FILE_TOOLS_CONFIG"] = configPath;
	await writeFile(configPath, [
		"{",
		'  "blocked_path": [".git/"],',
		'  "ignored_path": [],',
		'  "ignore": { "builtin_profile": "none", "gitignore": false }',
		"}",
	].join("\n"));
});

describe("grep without tree-sitter", () => {
	it("受支持语言在 grammar runtime 缺失时由 auto 降级到文本 lexical 通道", async () => {
		await writeFile(path.join(workspaceTemp.path, "target.ts"), [
			"export function RemoteSymbol() {",
			"  throw new Error('fatal authentication token failure');",
			"}",
		].join("\n"));

		const exact = await grepWorkspaceFiles(workspaceTemp.path, { query: "RemoteSymbol" });
		expect(exact).toMatchObject({
			status: "success",
			regions: [{ path: "target.ts", kind: "text", reasons: ["exact literal"] }],
		});

		const lexical = await grepWorkspaceFiles(workspaceTemp.path, { query: "authentication failure" });
		expect(lexical).toMatchObject({
			status: "success",
			regions: [{ path: "target.ts", kind: "text", reasons: ["lexical"] }],
		});
	});
});
