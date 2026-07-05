import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadFileToolsConfig } from "../src/file-tools/config.js";

let workspace: string;
let previousConfigPath: string | undefined;

beforeEach(async () => {
	workspace = await mkdtemp(path.join(os.tmpdir(), "o-pi-file-tools-config-"));
	previousConfigPath = process.env.PI_FILE_TOOLS_CONFIG;
});

afterEach(async () => {
	if (previousConfigPath === undefined) delete process.env.PI_FILE_TOOLS_CONFIG;
	else process.env.PI_FILE_TOOLS_CONFIG = previousConfigPath;
	await rm(workspace, { recursive: true, force: true });
});

describe("file-tools config", () => {
	it("接受收缩后的 find 配置并拒绝旧 find 字段", async () => {
		const validPath = path.join(workspace, "valid.jsonc");
		await writeFile(
			validPath,
			[
				"{",
				'  "version": 1,',
				'  "limits": {',
				'    "find_output_token_budget": 800,',
				'    "find_result_limit": 50,',
				'    "find_max_entries_scanned": 100000',
				"  }",
				"}",
			].join("\n"),
		);
		process.env.PI_FILE_TOOLS_CONFIG = validPath;
		expect(await loadFileToolsConfig()).toMatchObject({
			limits: {
				find_output_token_budget: 800,
				find_result_limit: 50,
				find_max_entries_scanned: 100000,
			},
		});

		const invalidPath = path.join(workspace, "invalid.jsonc");
		await writeFile(
			invalidPath,
			[
				"{",
				'  "version": 1,',
				'  "limits": {',
				'    "find_flat_result_limit": 5,',
				'    "find_grouped_result_limit": 40,',
				'    "find_max_matches_scanned": 100000,',
				'    "find_max_exact_paths": 200',
				"  }",
				"}",
			].join("\n"),
		);
		process.env.PI_FILE_TOOLS_CONFIG = invalidPath;
		expect(await loadFileToolsConfig()).toMatchObject({
			status: "failed",
			error: { code: "CONFIG_ERROR" },
		});
	});
});
