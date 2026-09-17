import { writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadAutoTitleConfig } from "../../../src/harness/auto-title/config.ts";
import { preserveEnv, setTestHome, useTempDir } from "../../helpers/lifecycle.ts";

const temp = useTempDir("opi-auto-title-config-");
preserveEnv("HOME", "USERPROFILE", "PI_AUTO_TITLE_CONFIG");
beforeEach(() => {
	setTestHome(temp.path);
	process.env.PI_AUTO_TITLE_CONFIG = path.join(temp.path, "auto-title.jsonc");
});

describe("自动标题配置", () => {
	it("默认启用，使用当前模型，提示词来自默认配置", async () => {
		const config = await loadAutoTitleConfig(temp.path);
		expect(config).toMatchObject({ enabled: true, model: null });
		expect(config.system_prompt).toContain("session title");
	});
	it("用户可以稀疏覆盖开关、模型和提示词", async () => {
		await writeFile(path.join(temp.path, "auto-title.jsonc"), JSON.stringify({
			model: "local/small", system_prompt: "只输出标题。",
		}));
		expect(await loadAutoTitleConfig(temp.path)).toMatchObject({
			enabled: true, model: "local/small", system_prompt: "只输出标题。",
		});
		await writeFile(path.join(temp.path, "auto-title.jsonc"), '{"enabled":false}');
		expect(await loadAutoTitleConfig(temp.path)).toMatchObject({ enabled: false, model: null });
	});
	it.each([
		{ model: { provider: "local", id: "small" } }, { model: "small" },
		{ model: "/small" }, { model: "local/" }, { model: "local/ small" },
		{ model: " local/small" }, { system_prompt: " " }, { unknown: true },
	])("拒绝无效配置 %j", async (value) => {
		await writeFile(path.join(temp.path, "auto-title.jsonc"), JSON.stringify(value));
		await expect(loadAutoTitleConfig(temp.path)).rejects.toThrow("does not match schema");
	});
});
