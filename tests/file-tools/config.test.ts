import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { FileToolsConfigProvider, loadFileToolsConfig } from "../../src/file-tools/config.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

let workspace: string;
const temp = useTempDir("o-pi-file-tools-config-");
preserveEnv("PI_FILE_TOOLS_CONFIG", "PI_FILE_TOOLS_PROJECT_CONFIG", "PI_FILE_TOOLS_PROJECT_ROOT");

beforeEach(() => {
	workspace = temp.path;
	delete process.env.PI_FILE_TOOLS_PROJECT_CONFIG;
	delete process.env.PI_FILE_TOOLS_PROJECT_ROOT;
});

describe("file-tools config", () => {
	it("默认启用路径建议和三个 16 MiB 单文件上限且支持覆盖", async () => {
		delete process.env.PI_FILE_TOOLS_CONFIG;
		expect(await loadedConfig(workspace)).toMatchObject({
			limits: {
				read_suggestion_limit: 3,
				read_max_file_bytes: 16 * 1024 * 1024,
				write_max_file_bytes: 16 * 1024 * 1024,
				edit_max_file_bytes: 16 * 1024 * 1024,
			},
		});

		const configPath = path.join(workspace, "read-suggestions.jsonc");
		await writeFile(configPath, JSON.stringify({ limits: { read_suggestion_limit: 7 } }));
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		expect(await loadedConfig(workspace)).toMatchObject({ limits: { read_suggestion_limit: 7 } });
	});

	it("接受单文件上限边界值", async () => {
		const configPath = path.join(workspace, "file-byte-limits.jsonc");
		await writeFile(configPath, JSON.stringify({
			limits: {
				read_max_file_bytes: 1024,
				write_max_file_bytes: 104857600,
				edit_max_file_bytes: 2048,
			},
		}));
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		expect(await loadedConfig(workspace)).toMatchObject({
			limits: {
				read_max_file_bytes: 1024,
				write_max_file_bytes: 104857600,
				edit_max_file_bytes: 2048,
			},
		});
	});

	it.each([
		["read_max_file_bytes", 1023],
		["read_max_file_bytes", 104857601],
		["write_max_file_bytes", 1023],
		["write_max_file_bytes", 104857601],
		["edit_max_file_bytes", 1023],
		["edit_max_file_bytes", 104857601],
	])("拒绝非法单文件上限 %s=%i", async (field, value) => {
		const configPath = path.join(workspace, `invalid-${field}-${value}.jsonc`);
		await writeFile(configPath, JSON.stringify({ limits: { [field]: value } }));
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		expect(await loadFileToolsConfig(workspace)).toMatchObject({ ok: false, error: { message: expect.any(String) } });
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
		expect(await loadedConfig(workspace)).toMatchObject({
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
		expect(await loadFileToolsConfig(workspace)).toMatchObject({ ok: false, error: { message: expect.any(String) } });

		const undersizedPath = path.join(workspace, "undersized.jsonc");
		await writeFile(undersizedPath, JSON.stringify({ limits: { find_output_token_budget: 31 } }));
		process.env.PI_FILE_TOOLS_CONFIG = undersizedPath;
		expect(await loadFileToolsConfig(workspace)).toMatchObject({ ok: false, error: { message: expect.any(String) } });
	});

	it("接受深度与输出 grep 限制并拒绝旧字段", async () => {
		const validPath = path.join(workspace, "grep-limits.jsonc");
		await writeFile(validPath, JSON.stringify({ limits: {
			grep_max_depth: 6,
			grep_ast_max_file_bytes: 128 * 1024,
			grep_output_token_budget: 2000,
			grep_result_limit: 12,
		} }));
		process.env.PI_FILE_TOOLS_CONFIG = validPath;
		expect(await loadedConfig(workspace)).toMatchObject({ limits: {
			grep_max_depth: 6,
			grep_ast_max_file_bytes: 128 * 1024,
			grep_output_token_budget: 2000,
			grep_result_limit: 12,
		} });

		for (const [field, value] of [["grep_max_depth", -1], ["grep_max_depth", 257], ["grep_ast_max_file_bytes", 1023]] as const) {
			const invalidPath = path.join(workspace, `invalid-${field}-${value}.jsonc`);
			await writeFile(invalidPath, JSON.stringify({ limits: { [field]: value } }));
			process.env.PI_FILE_TOOLS_CONFIG = invalidPath;
			expect(await loadFileToolsConfig(workspace)).toMatchObject({ ok: false, error: { message: expect.any(String) } });
		}

		for (const field of [
			"grep_max_entries_traversed",
			"grep_max_text_bytes_scanned",
			"grep_max_text_file_bytes",
			"grep_max_files_parsed",
			"grep_max_parse_file_bytes",
			"grep_max_file_bytes",
			"grep_max_files_scanned",
			"grep_max_semantic_files",
			"grep_max_semantic_parse_bytes",
		]) {
			const invalidPath = path.join(workspace, `old-${field}.jsonc`);
			await writeFile(invalidPath, JSON.stringify({ limits: { [field]: 1024 } }));
			process.env.PI_FILE_TOOLS_CONFIG = invalidPath;
			expect(await loadFileToolsConfig(workspace)).toMatchObject({ ok: false, error: { message: expect.any(String) } });
		}
	});

	it("合并项目配置但不允许项目关闭用户级 ignore 开关", async () => {
		const userPath = path.join(workspace, "user.jsonc");
		await writeFile(userPath, JSON.stringify({
			blocked_path: ["user-block/"],
			ignored_path: ["user-ignore/"],
			limits: { ls_entries: 100, write_max_file_bytes: 2048 },
			ignore: { piignore: false, builtin_profile: "minimal" },
		}));
		process.env.PI_FILE_TOOLS_CONFIG = userPath;

		await mkdir(path.join(workspace, ".pi", "configs"), { recursive: true });
		await writeFile(path.join(workspace, ".pi", "configs", "file-tools.jsonc"), JSON.stringify({
			blocked_path: ["project-block/"],
			ignored_path: ["project-ignore/"],
			limits: { ls_entries: 20, grep_result_limit: 3, edit_max_file_bytes: 4096 },
			ignore: { builtin_profile: "performance" },
		}));

		expect(await loadedConfig(workspace)).toMatchObject({
			filesystem: {
				blockedPaths: ["user-block/", "project-block/"],
				visibility: {
					ignoredPaths: ["user-ignore/", "project-ignore/"],
					ignore: { piignore: { enabled: false }, builtinProfile: "performance" },
				},
			},
			limits: {
				ls_entries: 20,
				grep_result_limit: 3,
				write_max_file_bytes: 2048,
				edit_max_file_bytes: 4096,
			},
		});

		await writeFile(path.join(workspace, ".pi", "configs", "file-tools.jsonc"), JSON.stringify({ ignore: { piignore: true } }));
		expect(await loadFileToolsConfig(workspace)).toMatchObject({ ok: false, error: { message: expect.any(String) } });
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

		const [first, second] = await Promise.all([loadedConfig(firstRoot), loadedConfig(secondRoot)]);
		expect(first).toMatchObject({ limits: { ls_entries: 11 } });
		expect(second).toMatchObject({ limits: { ls_entries: 22 } });
	});

	it("并发复用配置加载且每个调用返回独立结果", async () => {
		const configPath = path.join(workspace, "cached.jsonc");
		await writeFile(configPath, JSON.stringify({ blocked_path: ["private/"] }));
		process.env.PI_FILE_TOOLS_CONFIG = configPath;

		const provider = new FileToolsConfigProvider();
		try {
			const [firstResult, secondResult] = await Promise.all([provider.load(workspace), provider.load(workspace)]);
			if (!firstResult.ok || !secondResult.ok) throw new Error("config failed");
			const first = firstResult.value;
			const second = secondResult.value;
			expect(first).toEqual(second);
			expect(first).not.toBe(second);
			(first.filesystem.blockedPaths as string[]).push("mutated/");
			const third = await provider.load(workspace);
			expect(third).not.toMatchObject({
				ok: true,
				value: { filesystem: { blockedPaths: expect.arrayContaining(["mutated/"]) } },
			});
		} finally {
			provider.dispose();
		}
	});
});

async function loadedConfig(cwd: string) {
	const result = await loadFileToolsConfig(cwd);
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}
