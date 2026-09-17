import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { parse } from "jsonc-parser";
import { GuiHost } from "../../src/gui/host/host.ts";
import { CONFIG_DEFINITIONS } from "../../src/harness/config-loader.ts";
import { moduleConfigIds } from "../../src/gui/module-config.ts";
import { preserveEnv, setTestHome, useTempDir } from "../helpers/lifecycle.ts";

const temp = useTempDir("opi-module-config-");
const envs = moduleConfigIds.map((id) => id === "tools" ? "PI_TOOLS_CONFIG" : CONFIG_DEFINITIONS[id].userEnv);
preserveEnv("HOME", "USERPROFILE", ...envs);
let host: GuiHost;
beforeEach(() => {
	setTestHome(temp.path);
	for (const env of envs) delete process.env[env];
	host = new GuiHost();
});
afterEach(async () => { await host.dispose(); });

it.each(moduleConfigIds)("无会话时读取和保存 %s 全局覆盖，不改默认配置", async (id) => {
	const initial = await host.query({ query: "moduleConfig", id });
	expect(initial.content).toBe("");
	expect(parse(initial.defaults)).toBeTypeOf("object");
	const content = "{\n // 保留用户注释\n}\n";
	await host.dispatch({ action: "saveModuleConfig", id, original: "", content });
	expect(await readFile(initial.path, "utf8")).toBe(content);
	expect((await host.query({ query: "moduleConfig", id })).defaults).toBe(initial.defaults);
});

it("沿用环境变量重定向路径，拒绝旧版本覆盖，允许读取损坏配置后修复", async () => {
	const file = path.join(temp.path, "redirect", "web.jsonc");
	process.env.PI_WEB_TOOLS_CONFIG = file;
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, "{broken");
	expect(await host.query({ query: "moduleConfig", id: "webTools" })).toMatchObject({ path: file, content: "{broken" });
	await host.dispatch({ action: "saveModuleConfig", id: "webTools", original: "{broken", content: "{}" });
	await expect(host.dispatch({ action: "saveModuleConfig", id: "webTools", original: "{broken", content: "{}" })).rejects.toThrow("已被修改");
	expect(await readFile(file, "utf8")).toBe("{}");
});

it.each(["[]", "null", "", "{", '{"max_parallel_tasks":0}', '{"max_parallel_tasks":"2"}', '{"unknown":true}'])("拒绝非法配置 %s", async (content) => {
	await expect(host.dispatch({ action: "saveModuleConfig", id: "subagent", original: "", content })).rejects.toThrow();
	expect((await host.query({ query: "moduleConfig", id: "subagent" })).content).toBe("");
});

it("重置字段只删除覆盖，不写入默认值", async () => {
	await host.dispatch({ action: "saveModuleConfig", id: "subagent", original: "", content: '{"max_parallel_tasks":4}' });
	await host.dispatch({ action: "saveModuleConfig", id: "subagent", original: '{"max_parallel_tasks":4}', content: '{}' });
	const config = await host.query({ query: "moduleConfig", id: "subagent" });
	expect(parse(config.content)).not.toHaveProperty("max_parallel_tasks");
	expect(parse(config.defaults)).toHaveProperty("max_parallel_tasks", 4);
});

it("配置接口不接受文件路径或未注册模块", async () => {
	await expect(host.query({ query: "moduleConfig", id: "../../secret" })).rejects.toThrow("无效");
	await expect(host.dispatch({ action: "saveModuleConfig", id: "gui", original: "", content: "{}" })).rejects.toThrow("无效");
});
