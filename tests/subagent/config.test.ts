import { writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultSubagentConfig, loadSubagentConfig, mergeProjectConfig, mergeUserConfig } from "../../src/subagent/config.js";
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
		expect(await loadSubagentConfig(dir)).toEqual(defaultSubagentConfig());
	});

	it("支持 JSONC 注释和 trailing comma", async () => {
		await writeFile(
			process.env.PI_SUBAGENT_USER_CONFIG!,
			`{
				// local GPU default
				"max_concurrency": 2,
				"max_inline_output_tokens": 2500,
				"max_handoff_tokens": 3500,
			}`,
		);
		expect(await loadSubagentConfig(dir)).toMatchObject({ maxConcurrency: 2, maxInlineOutputTokens: 2500, maxHandoffTokens: 3500 });
	});

	it("非法 JSONC 和数值范围报错", async () => {
		await writeFile(process.env.PI_SUBAGENT_USER_CONFIG!, "{");
		await expect(loadSubagentConfig(dir)).rejects.toThrow("not valid JSONC");
		await writeFile(process.env.PI_SUBAGENT_USER_CONFIG!, '{ "max_concurrency": 0 }');
		await expect(loadSubagentConfig(dir)).rejects.toThrow("does not match schema");
	});

	it("项目配置不能扩大安全边界", () => {
		const user = mergeUserConfig(defaultSubagentConfig(), { allow_project_agents: false, confirm_write_agents: true });
		const merged = mergeProjectConfig(user, { allow_project_agents: true, confirm_write_agents: false, max_concurrency: 2 });
		expect(merged.allowProjectAgents).toBe(false);
		expect(merged.confirmWriteAgents).toBe(true);
		expect(merged.maxConcurrency).toBe(2);
	});

	it("加载时明确拒绝项目配置中的全局专用字段", async () => {
		await writeFile(process.env.PI_SUBAGENT_PROJECT_CONFIG!, '{ "allow_project_agents": true }');
		await expect(loadSubagentConfig(dir)).rejects.toThrow("does not match schema");
	});
});
