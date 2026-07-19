import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { clearFileToolsConfigCache, loadFileToolsConfig } from "../../src/file-tools/config.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

let workspace: string;
const temp = useTempDir("o-pi-file-tools-config-");
preserveEnv("PI_FILE_TOOLS_CONFIG", "PI_FILE_TOOLS_PROJECT_CONFIG", "PI_FILE_TOOLS_PROJECT_ROOT");

beforeEach(() => {
	workspace = temp.path;
	delete process.env.PI_FILE_TOOLS_PROJECT_CONFIG;
	delete process.env.PI_FILE_TOOLS_PROJECT_ROOT;
	clearFileToolsConfigCache();
});

describe("file-tools config", () => {
	it("接受收缩后的 find 配置并拒绝旧 find 字段", async () => {
		const validPath = path.join(workspace, "valid.jsonc");
		await writeFile(
			validPath,
			[
				"{",
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

		const undersizedPath = path.join(workspace, "undersized.jsonc");
		await writeFile(undersizedPath, JSON.stringify({ limits: { find_output_token_budget: 31 } }));
		process.env.PI_FILE_TOOLS_CONFIG = undersizedPath;
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
			JSON.stringify({ ignore: { piignore: true } }),
		);
		expect(await loadFileToolsConfig(workspace)).toMatchObject({
			status: "failed",
			error: { code: "CONFIG_ERROR" },
		});
	});

	it("并发复用配置加载且每个调用返回独立结果", async () => {
		const configPath = path.join(workspace, "cached.jsonc");
		await writeFile(configPath, JSON.stringify({ blocked_path: ["private/"] }));
		process.env.PI_FILE_TOOLS_CONFIG = configPath;

		const [first, second] = await Promise.all([loadFileToolsConfig(), loadFileToolsConfig()]);
		if ("status" in first || "status" in second) throw new Error("config failed");
		expect(first).toEqual(second);
		expect(first).not.toBe(second);
		first.blocked_path.push("mutated/");
		expect((await loadFileToolsConfig())).not.toMatchObject({ blocked_path: expect.arrayContaining(["mutated/"]) });
	});
});
