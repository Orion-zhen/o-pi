import { writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadSubagentConfig } from "../../src/subagent/config.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

let dir: string;
const temp = useTempDir("o-pi-subagent-config-");
preserveEnv("PI_SUBAGENT_USER_CONFIG", "PI_SUBAGENT_PROJECT_CONFIG");

beforeEach(() => {
	dir = temp.path;
	process.env.PI_SUBAGENT_USER_CONFIG = path.join(dir, "user.jsonc");
	process.env.PI_SUBAGENT_PROJECT_CONFIG = path.join(dir, "project.jsonc");
});

describe("subagent config", () => {
	it("缺少覆盖文件时加载完整默认层", async () => {
		expect(await loadSubagentConfig(dir)).toEqual({
			maxParallelTasks: 4,
			maxConcurrency: 1,
			timeoutMs: 600_000,
			retries: 1,
			retryDelayMs: 1_000,
			retryOnEmptyOutput: true,
			retryOnTimeout: false,
			maxInlineOutputTokens: 8_000,
			maxHandoffTokens: 6_000,
			allowProjectAgents: false,
			projectAgentsOverrideUser: false,
			confirmWriteAgents: true,
			defaultTools: ["read", "grep", "find", "ls"],
			agentOverrides: {},
		});
	});

	it("支持 JSONC 注释和 trailing comma", async () => {
		await writeFile(
			path.join(dir, "user.jsonc"),
			`{
				// local GPU default
				"max_concurrency": 2,
				"max_inline_output_tokens": 2500,
				"max_handoff_tokens": 3500,
			}`,
		);
		expect(await loadSubagentConfig(dir)).toMatchObject({ maxConcurrency: 2, maxInlineOutputTokens: 2500, maxHandoffTokens: 3500 });
	});

	it("非法 JSONC、数值范围和重复工具报错", async () => {
		await writeFile(path.join(dir, "user.jsonc"), "{");
		await expect(loadSubagentConfig(dir)).rejects.toThrow("not valid JSONC");
		await writeFile(path.join(dir, "user.jsonc"), '{ "max_concurrency": 0 }');
		await expect(loadSubagentConfig(dir)).rejects.toThrow("does not match schema");
		await writeFile(path.join(dir, "user.jsonc"), '{ "retries": 6 }');
		await expect(loadSubagentConfig(dir)).rejects.toThrow("does not match schema");
		await writeFile(path.join(dir, "user.jsonc"), '{ "default_tools": ["read", "read"] }');
		await expect(loadSubagentConfig(dir)).rejects.toThrow("does not match schema");
	});

	it("用户和项目配置共同覆盖重试策略", async () => {
		await writeFile(path.join(dir, "user.jsonc"), JSON.stringify({
			retries: 2,
			retry_delay_ms: 50,
			retry_on_empty_output: false,
			retry_on_timeout: true,
		}));
		await writeFile(path.join(dir, "project.jsonc"), JSON.stringify({ retries: 3, retry_on_timeout: false }));

		expect(await loadSubagentConfig(dir)).toMatchObject({
			retries: 3,
			retryDelayMs: 50,
			retryOnEmptyOutput: false,
			retryOnTimeout: false,
		});
	});

	it.each([
		["user", "agent_scope"],
		["project", "allow_project_agents"],
	] as const)("拒绝 %s 配置中的越权字段 %s", async (layer, field) => {
		const configPath = path.join(dir, layer === "user" ? "user.jsonc" : "project.jsonc");
		await writeFile(configPath, JSON.stringify({ [field]: true }));
		await expect(loadSubagentConfig(dir)).rejects.toThrow("does not match schema");
	});
});
