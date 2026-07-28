import { writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

const treeSitterFailure = vi.hoisted(() => ({
	code: "RUNTIME_UNAVAILABLE",
	message: "simulated runtime failure",
}));

vi.mock("../../src/code-index/tree-sitter-loader.js", () => ({
	DEFAULT_PARSE_TIMEOUT_MICROS: 250_000,
	loadTreeSitterParser: async () => ({ failure: { ...treeSitterFailure } }),
}));

import { clearGrepTestRuntime as clearGrepIndex } from "../helpers/grep-tool.js";
import { grepWorkspaceFiles } from "../helpers/grep-tool.js";

const workspaceTemp = useTempDir("o-pi-grep-no-tree-sitter-");
const configTemp = useTempDir("o-pi-grep-no-tree-sitter-config-");
preserveEnv("PI_FILE_TOOLS_CONFIG");

beforeEach(async () => {
	clearGrepIndex();
	treeSitterFailure.code = "RUNTIME_UNAVAILABLE";
	treeSitterFailure.message = "simulated runtime failure";
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
	it("受支持语言在 Tree-sitter runtime 缺失时安全降级", async () => {
		await writeFile(path.join(workspaceTemp.path, "target.ts"), [
			"export function RemoteSymbol() {",
			"  throw new Error('fatal authentication token failure');",
			"}",
		].join("\n"));

		const exact = await grepWorkspaceFiles(workspaceTemp.path, { query: "RemoteSymbol" });
		expect(exact).toMatchObject({
			status: "success",
			regions: [{ path: "target.ts", kind: "text", matched_by: ["literal"] }],
		});

		const lexical = await grepWorkspaceFiles(workspaceTemp.path, { query: "authentication failure" });
		expect(lexical).toMatchObject({
			status: "success",
			regions: [{ path: "target.ts", kind: "text", matched_by: ["lexical"] }],
		});

		const strict = await grepWorkspaceFiles(workspaceTemp.path, { query: "RemoteSymbol", match: "literal" });
		expect(strict).toMatchObject({
			status: "success",
			stats: { parsed_files: 0 },
			regions: [expect.objectContaining({ path: "target.ts", kind: "text", query_match: "verified", match_lines: [1] })],
		});
	});

	it.each([
		["GRAMMAR_UNAVAILABLE", "grammar"],
		["PARSER_TIMEOUT", "timeout"],
	] as const)("%s 时 strict 保留 verified 文本行", async (code, name) => {
		treeSitterFailure.code = code;
		treeSitterFailure.message = `simulated ${name} failure`;
		const query = `${name}Needle`;
		await writeFile(path.join(workspaceTemp.path, `${name}.ts`), `export function ${name}() { return '${query}'; }\n`);

		const result = await grepWorkspaceFiles(workspaceTemp.path, { query, match: "literal" });

		expect(result).toMatchObject({
			status: "success",
			stats: { parsed_files: 0 },
			regions: [expect.objectContaining({
				path: `${name}.ts`,
				kind: "text",
				query_match: "verified",
				match_lines: [1],
			})],
		});
	});
});
