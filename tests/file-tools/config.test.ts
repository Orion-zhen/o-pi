import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadFileToolsConfig } from "../../src/file-tools/config.js";

let workspace: string;
let previousConfigPath: string | undefined;
let previousProjectConfigPath: string | undefined;
let previousProjectRoot: string | undefined;

beforeEach(async () => {
	workspace = await mkdtemp(path.join(os.tmpdir(), "o-pi-file-tools-config-"));
	previousConfigPath = process.env.PI_FILE_TOOLS_CONFIG;
	previousProjectConfigPath = process.env.PI_FILE_TOOLS_PROJECT_CONFIG;
	previousProjectRoot = process.env.PI_FILE_TOOLS_PROJECT_ROOT;
	delete process.env.PI_FILE_TOOLS_PROJECT_CONFIG;
	delete process.env.PI_FILE_TOOLS_PROJECT_ROOT;
});

afterEach(async () => {
	if (previousConfigPath === undefined) delete process.env.PI_FILE_TOOLS_CONFIG;
	else process.env.PI_FILE_TOOLS_CONFIG = previousConfigPath;
	if (previousProjectConfigPath === undefined) delete process.env.PI_FILE_TOOLS_PROJECT_CONFIG;
	else process.env.PI_FILE_TOOLS_PROJECT_CONFIG = previousProjectConfigPath;
	if (previousProjectRoot === undefined) delete process.env.PI_FILE_TOOLS_PROJECT_ROOT;
	else process.env.PI_FILE_TOOLS_PROJECT_ROOT = previousProjectRoot;
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

	it("合并项目配置但不允许项目关闭用户级 ignore 开关", async () => {
		const userPath = path.join(workspace, "user.jsonc");
		await writeFile(
			userPath,
			JSON.stringify({
				version: 1,
				blocked_path: ["user-block/"],
				ignored_path: ["user-ignore/"],
				limits: { ls_entries: 100 },
				ignore: { piignore: false, builtin_profile: "minimal" },
			}),
		);
		process.env.PI_FILE_TOOLS_CONFIG = userPath;

		await mkdir(path.join(workspace, ".pi", "configs"), { recursive: true });
		await writeFile(
			path.join(workspace, ".pi", "configs", "file-tools.jsonc"),
			JSON.stringify({
				version: 1,
				blocked_path: ["project-block/"],
				ignored_path: ["project-ignore/"],
				limits: { ls_entries: 20, grep_result_limit: 3 },
				ignore: { builtin_profile: "performance" },
			}),
		);

		expect(await loadFileToolsConfig(workspace)).toMatchObject({
			blocked_path: ["user-block/", "project-block/"],
			ignored_path: ["user-ignore/", "project-ignore/"],
			limits: { ls_entries: 20, grep_result_limit: 3 },
			ignore: { piignore: false, builtin_profile: "performance" },
		});

		await writeFile(
			path.join(workspace, ".pi", "configs", "file-tools.jsonc"),
			JSON.stringify({ version: 1, ignore: { piignore: true } }),
		);
		expect(await loadFileToolsConfig(workspace)).toMatchObject({
			status: "failed",
			error: { code: "CONFIG_ERROR" },
		});
	});
});
