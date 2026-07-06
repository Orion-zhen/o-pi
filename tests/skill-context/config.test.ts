import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultSkillContextConfig, loadSkillContextConfig } from "../../src/skill-context/config.js";

let tempDir: string;
let previousConfig: string | undefined;

beforeEach(async () => {
	tempDir = await mkdtemp(path.join(os.tmpdir(), "o-pi-skill-config-"));
	previousConfig = process.env.PI_SKILL_CONTEXT_CONFIG;
});

afterEach(async () => {
	if (previousConfig === undefined) delete process.env.PI_SKILL_CONTEXT_CONFIG;
	else process.env.PI_SKILL_CONTEXT_CONFIG = previousConfig;
	await rm(tempDir, { recursive: true, force: true });
});

describe("skill context config", () => {
	it("缺省配置匹配 V1 默认值", () => {
		expect(defaultSkillContextConfig()).toMatchObject({
			version: 1,
			enabled: true,
			max_active: 1,
			on_load_conflict: "replace",
			clear_mode: "lazy",
			dedupe_read: true,
			max_body_chars: 20_000,
		});
	});

	it("读取 JSONC 并合并默认值", async () => {
		const configPath = path.join(tempDir, "skill-context.jsonc");
		await writeFile(configPath, '{\n"version": 1,\n"enabled": false,\n"max_active": 2\n}\n');
		process.env.PI_SKILL_CONTEXT_CONFIG = configPath;
		expect(await loadSkillContextConfig()).toMatchObject({ enabled: false, max_active: 2, clear_mode: "lazy" });
	});
});

