import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileToolsConfigProvider } from "../../src/file-tools/config.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-file-tools-config-");
preserveEnv("PI_FILE_TOOLS_CONFIG", "PI_FILE_TOOLS_PROJECT_CONFIG", "PI_FILE_TOOLS_PROJECT_ROOT");
let workspace: string;
let provider: FileToolsConfigProvider;

beforeEach(() => {
	workspace = temp.path;
	provider = new FileToolsConfigProvider();
	delete process.env.PI_FILE_TOOLS_PROJECT_CONFIG;
	delete process.env.PI_FILE_TOOLS_PROJECT_ROOT;
});

afterEach(() => { provider.dispose(); });

describe("file-tools config", () => {
	it("加载默认值并支持用户覆盖", async () => {
		delete process.env.PI_FILE_TOOLS_CONFIG;
		expect(await loadedConfig(workspace)).toMatchObject({
			filesystem: {
				blockedPaths: expect.arrayContaining(["~/.ssh/id_*", "~/.aws/credentials", ".env"]),
			},
			limits: {
				find_max_depth: 12,
				find_max_entries: 20_000,
				grep_max_depth: 12,
				grep_max_entries: 10_000,
				grep_max_search_bytes: 128 * 1024 * 1024,
				grep_ast_max_file_bytes: 262144,
				grep_content_cache_bytes: 16 * 1024 * 1024,
				grep_content_cache_entries: 2048,
				grep_result_limit: 24,
				grep_related_result_limit: 8,
				grep_regional_display_limit: 3,
				read_suggestion_limit: 3,
				read_max_file_bytes: 16 * 1024 * 1024,
				read_pdf_pages: 20,
				write_max_file_bytes: 16 * 1024 * 1024,
				edit_max_file_bytes: 16 * 1024 * 1024,
			},
		});

		await useConfig("override.jsonc", { limits: { read_suggestion_limit: 7 } });
		expect(await loadedConfig(workspace)).toMatchObject({ limits: { read_suggestion_limit: 7 } });
	});

	it("接受公开的 find、grep 和单文件限制", async () => {
		const limits = {
			read_max_file_bytes: 1024,
			read_pdf_pages: 100,
			write_max_file_bytes: 104857600,
			edit_max_file_bytes: 2048,
			find_output_token_budget: 800,
			find_result_limit: 50,
			find_max_depth: 6,
			find_max_entries: 5000,
			grep_max_depth: 6,
			grep_max_entries: 4000,
			grep_max_search_bytes: 64 * 1024 * 1024,
			grep_ast_max_file_bytes: 128 * 1024,
			grep_content_cache_bytes: 0,
			grep_content_cache_entries: 1,
			grep_result_limit: 12,
			grep_related_result_limit: 0,
			grep_regional_display_limit: 7,
		};
		await useConfig("valid-limits.jsonc", { limits });
		expect(await loadedConfig(workspace)).toMatchObject({ limits });
	});

	it.each([
		["read_max_file_bytes", 1023], ["read_max_file_bytes", 104857601],
		["read_pdf_pages", 0], ["read_pdf_pages", 101],
		["write_max_file_bytes", 1023], ["write_max_file_bytes", 104857601],
		["edit_max_file_bytes", 1023], ["edit_max_file_bytes", 104857601],
		["find_output_token_budget", 31], ["find_max_depth", -1], ["find_max_depth", 257],
		["find_max_entries", 0], ["find_max_entries", 1000001],
		["grep_max_depth", -1], ["grep_max_depth", 257],
		["grep_max_entries", 0], ["grep_max_entries", 1000001],
		["grep_max_search_bytes", 1023], ["grep_max_search_bytes", 10737418241],
		["grep_ast_max_file_bytes", 1023], ["grep_ast_max_file_bytes", 104857601],
		["grep_content_cache_bytes", -1], ["grep_content_cache_bytes", 104857601],
		["grep_content_cache_entries", -1], ["grep_content_cache_entries", 100001],
		["grep_result_limit", 0], ["grep_result_limit", 51],
		["grep_related_result_limit", -1], ["grep_related_result_limit", 51],
		["grep_regional_display_limit", 0], ["grep_regional_display_limit", 21],
	] as const)("拒绝越界限制 %s=%i", async (field, value) => {
		await useConfig(`invalid-${field}-${value}.jsonc`, { limits: { [field]: value } });
		expect(await provider.load(workspace)).toMatchObject({ ok: false, error: { message: expect.any(String) } });
	});

	it("拒绝未知限制", async () => {
		await useConfig("unknown-limit.jsonc", { limits: { obsolete_limit: 1024 } });
		expect(await provider.load(workspace)).toMatchObject({ ok: false, error: { message: expect.any(String) } });
	});

	it.each(["grep_output_token_budget", "grep_relation_action_limit"])("拒绝已移除的 grep 限制 %s", async (field) => {
		await useConfig(`removed-${field}.jsonc`, { limits: { [field]: 1024 } });
		expect(await provider.load(workspace)).toMatchObject({ ok: false, error: { message: expect.any(String) } });
	});

	it("合并项目配置但不允许项目放宽用户 ignore 策略", async () => {
		await useConfig("user.jsonc", {
			blocked_path: ["user-block/"],
			ignored_path: ["user-ignore/"],
			limits: { ls_entries: 100, write_max_file_bytes: 2048 },
			ignore: { piignore: false, builtin_profile: "minimal" },
		});
		const projectConfig = path.join(workspace, ".pi", "configs", "file-tools.jsonc");
		await mkdir(path.dirname(projectConfig), { recursive: true });
		await writeFile(projectConfig, JSON.stringify({
			blocked_path: ["project-block/"],
			ignored_path: ["project-ignore/"],
			limits: { ls_entries: 20, grep_result_limit: 3, grep_regional_display_limit: 5, edit_max_file_bytes: 4096 },
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
			limits: { ls_entries: 20, grep_result_limit: 3, grep_regional_display_limit: 5, write_max_file_bytes: 2048, edit_max_file_bytes: 4096 },
		});

		await writeFile(projectConfig, JSON.stringify({ ignore: { piignore: true } }));
		expect(await provider.load(workspace)).toMatchObject({ ok: false, error: { message: expect.any(String) } });
	});

	it.each(["piignore", "gitignore", "git_tracked_files_bypass"] as const)("项目不能改写用户开关 %s", async (field) => {
		await useConfig("user-switch.jsonc", { ignore: { [field]: false } });
		const projectConfig = path.join(workspace, "project-switch.jsonc");
		process.env.PI_FILE_TOOLS_PROJECT_CONFIG = projectConfig;
		await writeFile(projectConfig, JSON.stringify({ ignore: { [field]: true } }));
		expect(await provider.load(workspace)).toMatchObject({
			ok: false,
			error: { details: { path: projectConfig, fields: [`ignore.${field}`] } },
		});
	});

	it("配置修正后失效旧错误缓存，关闭时不返回在途加载结果", async () => {
		const configPath = path.join(workspace, "changing.jsonc");
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		await writeFile(configPath, JSON.stringify({ limits: { ls_entries: 0 } }));
		const provider = new FileToolsConfigProvider();
		try {
			expect(await provider.load(workspace)).toMatchObject({ ok: false });
			await writeFile(configPath, JSON.stringify({ limits: { ls_entries: 123 } }));
			expect(await provider.load(workspace)).toMatchObject({ ok: true, value: { limits: { ls_entries: 123 } } });
			const loading = provider.load(workspace);
			provider.dispose();
			expect(await loading).toMatchObject({ ok: false });
			expect(await provider.load(workspace)).toMatchObject({ ok: false });
		} finally {
			provider.dispose();
		}
	});

	it("并发调用按 cwd 选择项目配置", async () => {
		await useConfig("user.jsonc", {});
		const roots = [path.join(workspace, "first"), path.join(workspace, "second")];
		await Promise.all(roots.map((root) => mkdir(path.join(root, ".pi", "configs"), { recursive: true })));
		await Promise.all(roots.map((root, index) => writeFile(
			path.join(root, ".pi", "configs", "file-tools.jsonc"),
			JSON.stringify({ limits: { ls_entries: index === 0 ? 11 : 22 } }),
		)));

		const [first, second] = await Promise.all(roots.map(loadedConfig));
		expect(first).toMatchObject({ limits: { ls_entries: 11 } });
		expect(second).toMatchObject({ limits: { ls_entries: 22 } });
	});

	it("并发复用加载且每次返回独立配置", async () => {
		await useConfig("cached.jsonc", { blocked_path: ["private/"] });
		const provider = new FileToolsConfigProvider();
		try {
			const [firstResult, secondResult] = await Promise.all([provider.load(workspace), provider.load(workspace)]);
			if (!firstResult.ok || !secondResult.ok) throw new Error("config failed");
			expect(firstResult.value).toEqual(secondResult.value);
			expect(firstResult.value).not.toBe(secondResult.value);
			(firstResult.value.filesystem.blockedPaths as string[]).push("mutated/");
			expect(await provider.load(workspace)).not.toMatchObject({
				ok: true,
				value: { filesystem: { blockedPaths: expect.arrayContaining(["mutated/"]) } },
			});
		} finally {
			provider.dispose();
		}
	});
});

async function useConfig(name: string, config: Record<string, unknown>): Promise<void> {
	const configPath = path.join(workspace, name);
	await writeFile(configPath, JSON.stringify(config));
	process.env.PI_FILE_TOOLS_CONFIG = configPath;
}

async function loadedConfig(cwd: string) {
	const result = await provider.load(cwd);
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}
