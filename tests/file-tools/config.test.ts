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
	it("默认启用三个 read 路径建议且支持覆盖数量", async () => {
		delete process.env.PI_FILE_TOOLS_CONFIG;
		expect(await loadFileToolsConfig(workspace)).toMatchObject({ limits: { read_suggestion_limit: 3 } });

		const configPath = path.join(workspace, "read-suggestions.jsonc");
		await writeFile(configPath, JSON.stringify({ limits: { read_suggestion_limit: 7 } }));
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		expect(await loadFileToolsConfig(workspace)).toMatchObject({ limits: { read_suggestion_limit: 7 } });
	});

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
		expect(await loadFileToolsConfig(workspace)).toMatchObject({
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
		expect(await loadFileToolsConfig(workspace)).toMatchObject({ status: "failed", error: { code: "CONFIG_ERROR" } });

		const undersizedPath = path.join(workspace, "undersized.jsonc");
		await writeFile(undersizedPath, JSON.stringify({ limits: { find_output_token_budget: 31 } }));
		process.env.PI_FILE_TOOLS_CONFIG = undersizedPath;
		expect(await loadFileToolsConfig(workspace)).toMatchObject({ status: "failed", error: { code: "CONFIG_ERROR" } });
	});

	it("合并项目配置但不允许项目关闭用户级 ignore 开关", async () => {
		const userPath = path.join(workspace, "user.jsonc");
		await writeFile(userPath, JSON.stringify({
			blocked_path: ["user-block/"],
			ignored_path: ["user-ignore/"],
			limits: { ls_entries: 100 },
			ignore: { piignore: false, builtin_profile: "minimal" },
		}));
		process.env.PI_FILE_TOOLS_CONFIG = userPath;

		await mkdir(path.join(workspace, ".pi", "configs"), { recursive: true });
		await writeFile(path.join(workspace, ".pi", "configs", "file-tools.jsonc"), JSON.stringify({
			blocked_path: ["project-block/"],
			ignored_path: ["project-ignore/"],
			limits: { ls_entries: 20, grep_result_limit: 3 },
			ignore: { builtin_profile: "performance" },
		}));

		expect(await loadFileToolsConfig(workspace)).toMatchObject({
			filesystem: {
				blockedPaths: ["user-block/", "project-block/"],
				visibility: {
					ignoredPaths: ["user-ignore/", "project-ignore/"],
					ignore: { piignore: { enabled: false }, builtinProfile: "performance" },
				},
			},
			limits: { ls_entries: 20, grep_result_limit: 3 },
		});

		await writeFile(path.join(workspace, ".pi", "configs", "file-tools.jsonc"), JSON.stringify({ ignore: { piignore: true } }));
		expect(await loadFileToolsConfig(workspace)).toMatchObject({ status: "failed", error: { code: "CONFIG_ERROR" } });
	});

	it("并发调用按各自 cwd 选择项目配置", async () => {
		const userPath = path.join(workspace, "user.jsonc");
		await writeFile(userPath, "{}\n");
		process.env.PI_FILE_TOOLS_CONFIG = userPath;
		const firstRoot = path.join(workspace, "first");
		const secondRoot = path.join(workspace, "second");
		await Promise.all([
			mkdir(path.join(firstRoot, ".pi", "configs"), { recursive: true }),
			mkdir(path.join(secondRoot, ".pi", "configs"), { recursive: true }),
		]);
		await Promise.all([
			writeFile(path.join(firstRoot, ".pi", "configs", "file-tools.jsonc"), JSON.stringify({ limits: { ls_entries: 11 } })),
			writeFile(path.join(secondRoot, ".pi", "configs", "file-tools.jsonc"), JSON.stringify({ limits: { ls_entries: 22 } })),
		]);

		const [first, second] = await Promise.all([loadFileToolsConfig(firstRoot), loadFileToolsConfig(secondRoot)]);
		expect(first).toMatchObject({ limits: { ls_entries: 11 } });
		expect(second).toMatchObject({ limits: { ls_entries: 22 } });
	});

	it("并发复用配置加载且每个调用返回独立结果", async () => {
		const configPath = path.join(workspace, "cached.jsonc");
		await writeFile(configPath, JSON.stringify({ blocked_path: ["private/"] }));
		process.env.PI_FILE_TOOLS_CONFIG = configPath;

		const [first, second] = await Promise.all([loadFileToolsConfig(workspace), loadFileToolsConfig(workspace)]);
		if ("status" in first || "status" in second) throw new Error("config failed");
		expect(first).toEqual(second);
		expect(first).not.toBe(second);
		(first.filesystem.blockedPaths as string[]).push("mutated/");
		expect(await loadFileToolsConfig(workspace)).not.toMatchObject({
			filesystem: { blockedPaths: expect.arrayContaining(["mutated/"]) },
		});
	});
});
