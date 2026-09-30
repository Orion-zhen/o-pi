import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

import { saveUserToolDefaults } from "../../../src/harness/tool-defaults/config.ts";
import { replaceConfigFile } from "../../../src/harness/config-file.ts";
import { preserveEnv, useTempDir } from "../../helpers/lifecycle.ts";

const temp = useTempDir("o-pi-tool-defaults-");
preserveEnv("PI_CODING_AGENT_DIR");
let agentDir: string;
let settingsPath: string;

beforeEach(() => {
	agentDir = path.join(temp.path, "agent");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	settingsPath = path.join(agentDir, "settings.json");
});

describe("原生 defaultTools 保存", () => {
	it.each([{ tools: ["read", "codemode"] }, { tools: [] }])("保存选择 $tools，Pi 原生设置直接读取", async ({ tools }) => {
		await expect(saveUserToolDefaults(tools)).resolves.toBe(settingsPath);
		expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({ defaultTools: tools });
		expect(SettingsManager.create(temp.path, agentDir).getDefaultTools()).toEqual(tools);
	});

	it("替换原有默认列表，保留其他设置及 SDK 后续写入", async () => {
		await mkdir(agentDir);
		await writeFile(settingsPath, JSON.stringify({ theme: "dark", defaultTools: ["+codemode"] }));
		const sdk = SettingsManager.create(temp.path, agentDir);
		await saveUserToolDefaults(["read", "bash"]);
		expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({ theme: "dark", defaultTools: ["read", "bash"] });
		sdk.setTheme("light");
		await sdk.flush();
		expect(sdk.drainErrors()).toEqual([]);
		expect(SettingsManager.create(temp.path, agentDir).getDefaultTools()).toEqual(["read", "bash"]);
		expect(JSON.parse(await readFile(settingsPath, "utf8")).theme).toBe("light");
	});

	it.each(["{ invalid", "[]", "null"])("拒绝覆盖损坏的设置 %s", async (content) => {
		await mkdir(agentDir);
		await writeFile(settingsPath, content);
		await expect(saveUserToolDefaults(["read"])).rejects.toThrow();
		expect(await readFile(settingsPath, "utf8")).toBe(content);
	});

	it("拒绝用旧版本覆盖并发更新的设置", async () => {
		await saveUserToolDefaults(["read"]);
		const original = await readFile(settingsPath, "utf8");
		await saveUserToolDefaults(["bash"]);
		await expect(replaceConfigFile(settingsPath, original, "{}")).rejects.toThrow();
		expect(SettingsManager.create(temp.path, agentDir).getDefaultTools()).toEqual(["bash"]);
	});
});
