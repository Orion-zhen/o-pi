import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { findNearestProjectRoot, loadToolDefaultsConfig, resolveToolDefaults } from "../../src/tool-defaults/config.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

let workspace: string;
const temp = useTempDir("o-pi-tool-defaults-");
preserveEnv("PI_TOOLS_CONFIG", "PI_TOOLS_PROJECT_CONFIG", "PI_TOOLS_PROJECT_ROOT");

beforeEach(() => {
	workspace = temp.path;
	process.env.PI_TOOLS_CONFIG = path.join(workspace, "missing-user.jsonc");
	delete process.env.PI_TOOLS_PROJECT_CONFIG;
	delete process.env.PI_TOOLS_PROJECT_ROOT;
});

describe("tool defaults config", () => {
	it("缺少配置时没有覆盖，所有工具由调用方默认启用", async () => {
		const config = await loadToolDefaultsConfig(workspace);
		expect(config).toEqual({ layers: [] });
		expect(resolveToolDefaults(config, { provider: "local", id: "model" })).toEqual({});
	});

	it("用户层与项目层分别应用 defaults 和模型规则，项目层整体覆盖用户层", async () => {
		const userPath = path.join(workspace, "user.jsonc");
		process.env.PI_TOOLS_CONFIG = userPath;
		await writeFile(
			userPath,
			`{
				"$schema": "tools.schema.json",
				"defaults": { "bash": false, "read": true },
				"rules": [
					{ "match": "google/*", "tools": { "grep": false, "write": true } }
				]
			}`,
		);

		const projectRoot = path.join(workspace, "repo");
		await mkdir(path.join(projectRoot, ".pi"), { recursive: true });
		await writeFile(
			path.join(projectRoot, ".pi", "tools.jsonc"),
			`{
				"defaults": { "bash": true },
				"rules": [
					{ "match": "*/*", "tools": { "grep": true } },
					{ "match": "google/gemini-*", "tools": { "write": false } }
				]
			}`,
		);

		const config = await loadToolDefaultsConfig(path.join(projectRoot, "src"));
		expect(resolveToolDefaults(config, { provider: "google", id: "gemini-3.5-flash" })).toEqual({
			bash: true,
			read: true,
			grep: true,
			write: false,
		});
	});

	it("匹配规则按最长静态前缀合并，不依赖声明顺序", async () => {
		const userPath = path.join(workspace, "user.jsonc");
		process.env.PI_TOOLS_CONFIG = userPath;
		await writeFile(
			userPath,
			`{
				"defaults": { "websearch": true, "webfetch": false },
				"rules": [
					{ "match": "local/qwen3-*", "tools": { "webfetch": false } },
					{ "match": "*/*", "tools": { "websearch": false, "webfetch": true } },
					{ "match": "local/*", "tools": { "websearch": true } }
				]
			}`,
		);

		const config = await loadToolDefaultsConfig(workspace);
		expect(resolveToolDefaults(config, { provider: "local", id: "qwen3-coder" })).toEqual({
			websearch: true,
			webfetch: false,
		});
	});

	it("相同静态前缀后声明者优先，但精确匹配始终高于尾部通配符", async () => {
		const userPath = path.join(workspace, "user.jsonc");
		process.env.PI_TOOLS_CONFIG = userPath;
		await writeFile(
			userPath,
			`{
				"rules": [
					{ "match": "local/qwen3-coder", "tools": { "exact": true } },
					{ "match": "local/qwen3-*", "tools": { "tie": false } },
					{ "match": "local/qwen3-**", "tools": { "tie": true } },
					{ "match": "local/qwen3-coder*", "tools": { "exact": false } }
				]
			}`,
		);

		const config = await loadToolDefaultsConfig(workspace);
		expect(resolveToolDefaults(config, { provider: "local", id: "qwen3-coder" })).toMatchObject({
			tie: true,
			exact: true,
		});
	});

	it("星号可跨越 model id 中的斜杠", async () => {
		const userPath = path.join(workspace, "user.jsonc");
		process.env.PI_TOOLS_CONFIG = userPath;
		await writeFile(userPath, '{ "rules": [{ "match": "openrouter/*", "tools": { "websearch": false } }] }');

		const config = await loadToolDefaultsConfig(workspace);
		expect(resolveToolDefaults(config, { provider: "openrouter", id: "google/gemini-3.5-flash" })).toEqual({ websearch: false });
	});

	it("拒绝旧版顶层工具映射和无效规则", async () => {
		const userPath = path.join(workspace, "bad.jsonc");
		process.env.PI_TOOLS_CONFIG = userPath;

		await writeFile(userPath, '{ "bash": false }');
		await expect(loadToolDefaultsConfig(workspace)).rejects.toThrow("does not match schema");

		await writeFile(userPath, '{ "rules": [{ "match": "google/*", "tools": { "websearch": "off" } }] }');
		await expect(loadToolDefaultsConfig(workspace)).rejects.toThrow("does not match schema");

		await writeFile(userPath, '{ "rules": [{ "match": "google", "tools": {} }] }');
		await expect(loadToolDefaultsConfig(workspace)).rejects.toThrow("does not match schema");
	});

	it("从当前目录向上查找最近的 .pi 项目根", async () => {
		const projectRoot = path.join(workspace, "repo");
		const child = path.join(projectRoot, "packages", "demo");
		await mkdir(path.join(projectRoot, ".pi"), { recursive: true });
		await mkdir(child, { recursive: true });

		expect(findNearestProjectRoot(child)).toBe(projectRoot);
	});
});
