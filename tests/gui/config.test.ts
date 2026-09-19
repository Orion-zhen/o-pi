import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { GuiHost } from "../../src/gui/host/host.ts";
import type { GuiEvent } from "../../src/gui/contract.ts";
import { preserveEnv, setTestHome, useTempDir } from "../helpers/lifecycle.ts";

const temp = useTempDir("opi-gui-config-");
preserveEnv("HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_GUI_CONFIG");
let host: ReturnType<GuiHost["createClient"]>;
let file: string;
beforeEach(async () => {
	setTestHome(temp.path);
	process.env.PI_CODING_AGENT_DIR = path.join(temp.path, "custom-agent");
	delete process.env.PI_GUI_CONFIG;
	file = path.join(process.env.PI_CODING_AGENT_DIR, "configs", "gui.jsonc");
	await mkdir(path.dirname(file), { recursive: true });
	host = new GuiHost().createClient();
});
afterEach(async () => { await host.host.dispose(); });

it("未选择工作区也能读取默认值、保存 GUI 设置并广播，不创建会话", async () => {
	const initial = await host.query({ query: "guiConfig" });
	expect(initial).toMatchObject({ path: file, content: "", state: "ready", value: {
		theme: "system", themeColor: "#007AFF", fonts: { ui: [], code: [] }, fontSizes: { ui: 14, chat: 16, code: 14 }, sendShortcut: "mod-enter", sessionCache: { idleLimit: 3, idleMs: 60_000 },
	} });
	const events: GuiEvent[] = [];
	host.subscribe((event) => events.push(event));
	const content = '{\n // 自定义主题\n "theme": "dark",\n "themeColor": "#AF52DE",\n "fontSizes": {"chat": 20},\n}\n';
	await host.dispatch({ action: "saveGuiConfig", original: "", content });
	expect(await readFile(file, "utf8")).toBe(content);
	expect(events.filter((event) => event.type === "guiConfig").at(-1)).toMatchObject({ value: {
		state: "ready", value: { theme: "dark", themeColor: "#AF52DE", fontSizes: { ui: 14, chat: 20, code: 14 } },
	} });
	expect(events.filter((event) => event.type === "snapshot").map((event) => event.value)).toEqual([null]);
});

it("字体链保留顺序，空数组恢复系统字体，未覆盖的字体组保留默认值", async () => {
	const content = JSON.stringify({ fonts: { ui: ["Inter", "Noto Sans SC", "Apple Color Emoji"] } });
	await host.dispatch({ action: "saveGuiConfig", original: "", content });
	expect(await host.query({ query: "guiConfig" })).toMatchObject({ state: "ready", value: {
		fonts: { ui: ["Inter", "Noto Sans SC", "Apple Color Emoji"], code: [] },
	} });
	await host.dispatch({ action: "saveGuiConfig", original: content, content: '{"fonts":{"ui":[]}}' });
	expect(await host.query({ query: "guiConfig" })).toMatchObject({ state: "ready", value: { fonts: { ui: [], code: [] } } });
});

it.each([
	[{ idleLimit: 0 }, { idleLimit: 0, idleMs: 60_000 }],
	[{ idleMs: 1 }, { idleLimit: 3, idleMs: 1 }],
	[{ idleMs: 2_147_483_647 }, { idleLimit: 3, idleMs: 2_147_483_647 }],
	[{}, { idleLimit: 3, idleMs: 60_000 }],
])("回收策略允许边界值，未覆盖字段继承默认值: %j", async (sessionCache, expected) => {
	const content = JSON.stringify({ sessionCache });
	await host.dispatch({ action: "saveGuiConfig", original: "", content });
	expect(await readFile(file, "utf8")).toBe(content);
	expect(await host.query({ query: "guiConfig" })).toMatchObject({ state: "ready", value: { sessionCache: expected } });
});

it("外部变更后重新读取生效，旧编辑内容不能覆盖新文件", async () => {
	await writeFile(file, '{"theme":"dark"}');
	const original = (await host.query({ query: "guiConfig" })).content;
	await writeFile(file, '{"theme":"light"}');
	await expect(host.dispatch({ action: "saveGuiConfig", original, content: "{}" })).rejects.toThrow("已被修改");
	expect(await host.query({ query: "guiConfig" })).toMatchObject({ state: "ready", value: { theme: "light" } });
});

it.each(['{"fontSizes":{"ui":0}}', '{"theme":"blue"}', '{"unknown":true}', '{"theme":', '{"themeColor":"red"}', '{"themeColor":"#abc"}', '{"themeColor":"#12345678"}', '{"themeColor":123}',
	'{"fonts":{"ui":"Inter"}}', '{"fonts":{"code":[""]}}', '{"fonts":{"ui":["   "]}}',
	'{"fonts":{"ui":["Inter",1]}}', '{"fonts":{"ui":["Inter","Inter"]}}',
	'{"sessionCache":{"idleLimit":-1}}', '{"sessionCache":{"idleLimit":1.5}}', '{"sessionCache":{"idleLimit":"3"}}',
	'{"sessionCache":{"idleMs":0}}', '{"sessionCache":{"idleMs":-1}}', '{"sessionCache":{"idleMs":1.5}}',
	'{"sessionCache":{"idleMs":2147483648}}', '{"sessionCache":{"idleMs":"60000"}}',
	'{"sessionCache":{"unknown":true}}', '{"sessionCache":null}'])
("非法配置可在编辑器中读取和修复，但不能保存: %s", async (content) => {
	await expect(host.dispatch({ action: "saveGuiConfig", original: "", content })).rejects.toThrow();
	await writeFile(file, content);
	expect(await host.query({ query: "guiConfig" })).toMatchObject({ state: "error", content });
	await host.dispatch({ action: "saveGuiConfig", original: content, content: "{}\n" });
	expect(await host.query({ query: "guiConfig" })).toMatchObject({ state: "ready", value: { theme: "system" } });
});

it("用户配置路径可单独覆盖", async () => {
	process.env.PI_GUI_CONFIG = path.join(temp.path, "preferences.jsonc");
	await writeFile(process.env.PI_GUI_CONFIG, '{"sendShortcut":"enter"}');
	expect(await host.query({ query: "guiConfig" })).toMatchObject({ path: process.env.PI_GUI_CONFIG, state: "ready", value: { sendShortcut: "enter" } });
});
