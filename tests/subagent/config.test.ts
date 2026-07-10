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
	it("加载默认配置且默认并发为 1", async () => {
		expect(await loadSubagentConfig(dir)).toMatchObject({ maxConcurrency: 1, allowProjectAgents: false });
	});

	it("支持 JSONC 注释和 trailing comma", async () => {
		await writeFile(
			process.env.PI_SUBAGENT_USER_CONFIG!,
			`{
				// local GPU default
				"max_concurrency": 2,
				"output_mode": "file",
			}`,
		);
		expect(await loadSubagentConfig(dir)).toMatchObject({ maxConcurrency: 2, outputMode: "file" });
	});

	it("非法 JSONC 和数值范围报错", async () => {
		await writeFile(process.env.PI_SUBAGENT_USER_CONFIG!, "{");
		await expect(loadSubagentConfig(dir)).rejects.toThrow("not valid JSONC");
		await writeFile(process.env.PI_SUBAGENT_USER_CONFIG!, '{ "max_concurrency": 0 }');
		await expect(loadSubagentConfig(dir)).rejects.toThrow("out of range");
	});

	it("项目配置不能扩大安全边界", () => {
		const user = mergeUserConfig(defaultSubagentConfig(), { allow_project_agents: false, confirm_write_agents: true });
		const merged = mergeProjectConfig(user, { allow_project_agents: true, confirm_write_agents: false, max_concurrency: 2 });
		expect(merged.allowProjectAgents).toBe(false);
		expect(merged.confirmWriteAgents).toBe(true);
		expect(merged.maxConcurrency).toBe(2);
	});
});
