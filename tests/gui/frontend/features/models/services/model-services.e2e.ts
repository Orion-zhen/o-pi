import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { parse } from "jsonc-parser";
import { test, expect } from "../../../../helpers/fixture.ts";
import { selectSetting, selectSettingsCategory } from "../../../../helpers/settings-steps.ts";
import { THINKING_FORMATS } from "../../../../../../src/harness/model-services/compat-settings.ts";

const settings = (page: Page) => page.getByRole("dialog", { name: "设置", exact: true });
const services = (page: Page) => settings(page).getByRole("region", { name: "模型服务", exact: true });
const original = '{\n// 保留注释\n"providers":{"local":{"name":"Local AI","api":"openai-completions","baseUrl":"http://127.0.0.1:1/v1","apiKey":"local","models":[{"id":"base","name":"Base model"}],"custom":true},"anthropic":{"headers":{"X-Keep":"value"}}}}';
async function open(page: Page) {
	if ((page.viewportSize()?.width ?? 1200) < 768) await page.getByRole("button", { name: "菜单", exact: true }).click();
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await selectSettingsCategory(page, "模型服务");
}
async function save(page: Page) {
	const button = settings(page).getByRole("button", { name: "保存", exact: true });
	await button.click();
	await expect(button).toBeDisabled();
	await expect(settings(page).locator(".settings-actions").getByRole("status")).toHaveAccessibleName("已保存");
}
test.beforeEach(async ({ workspace: { agentDir } }) => { await writeFile(path.join(agentDir, "models.json"), original); });

test("编辑服务、增删模型和切换 JSON 共用草稿，保存与放弃不丢失其他配置", async ({ gui: { page }, workspace: { agentDir } }) => {
	const file = path.join(agentDir, "models.json");
	await open(page);
	const pane = services(page);
	await expect(pane.getByRole("article", { name: /^模型服务 / })).toHaveCount(2);
	await pane.getByRole("button", { name: "编辑服务 local", exact: true }).click();
	const local = pane.getByRole("article", { name: "模型服务 local", exact: true });
	await local.getByLabel("服务名称", { exact: true }).fill("本地模型");
	await local.getByLabel("API 地址", { exact: true }).fill("https://user:password@example.com/v1?key=secret");
	await expect(local.getByRole("button", { name: "编辑服务 local", exact: true })).toHaveText("本地模型localexample.com·openai-completions");
	await local.getByRole("button", { name: "添加模型", exact: true }).click();
	await local.getByLabel("模型 ID", { exact: true }).fill("reasoning-model");
	await local.getByRole("button", { name: "添加", exact: true }).click();
	const model = local.getByRole("article", { name: "模型 reasoning-model", exact: true });
	await model.getByLabel("上下文 Token", { exact: true }).fill("65536");
	await model.getByLabel("最大输出 Token", { exact: true }).fill("8192");
	await model.getByRole("toolbar", { name: "输入类型", exact: true }).getByRole("button", { name: "图片", exact: true }).click();
	await model.getByRole("switch", { name: "思考能力", exact: true }).check();
	await selectSetting(page, "默认思考等级", "high");
	await model.getByRole("button", { name: "采样参数", exact: true }).click();
	const temperature = model.getByLabel("温度", { exact: true });
	await temperature.fill("-");
	await expect(temperature).toHaveValue("-");
	await temperature.fill("0");
	await temperature.pressSequentially(".");
	await expect(temperature).toHaveValue("0.");
	await temperature.pressSequentially("7");
	await expect(temperature).toHaveValue("0.7");
	await selectSettingsCategory(page, "外观");
	await selectSettingsCategory(page, "模型服务");
	await expect(model.getByLabel("温度", { exact: true })).toHaveValue("0.7");
	expect(await readFile(file, "utf8")).toBe(original);
	await save(page);
	await expect(pane.getByText("待重载", { exact: true })).toBeVisible();
	const content = await readFile(file, "utf8");
	expect(content).toContain("// 保留注释");
	expect(parse(content)).toMatchObject({ providers: { local: { name: "本地模型", custom: true, models: [{ id: "base" }, { id: "reasoning-model", reasoning: true, contextWindow: 65536, maxTokens: 8192, defaultThinkingLevel: "high", input: ["text", "image"], samplingParams: { temperature: 0.7 } }] }, anthropic: { headers: { "X-Keep": "value" } } } });
	const base = local.getByRole("article", { name: "模型 base", exact: true });
	await base.getByRole("button", { name: "删除模型 base", exact: true }).click();
	await base.getByRole("button", { name: "确认删除模型 base", exact: true }).click();
	await expect(base).toHaveCount(0);
	await pane.getByRole("button", { name: "JSON", exact: true }).click();
	expect(parse(await pane.getByLabel("模型服务 JSON").innerText()).providers.local.models.map(({ id }: { id: string }) => id)).toEqual(["reasoning-model"]);
	await pane.getByRole("button", { name: "表单", exact: true }).click();
	await expect(base).toHaveCount(0);
	await save(page);
	const saved = `${await readFile(file, "utf8")}\n// 仅修改注释\n`;
	expect(parse(saved).providers.local.models.map(({ id }: { id: string }) => id)).toEqual(["reasoning-model"]);
	await pane.getByRole("button", { name: "JSON", exact: true }).click();
	await pane.getByLabel("模型服务 JSON").fill(saved);
	await save(page);
	expect(await readFile(file, "utf8")).toBe(saved);
	await pane.getByRole("button", { name: "表单", exact: true }).click();
	await local.getByLabel("服务名称", { exact: true }).fill("未保存的名称");
	await settings(page).getByRole("button", { name: "放弃", exact: true }).click();
	await expect(pane.getByRole("button", { name: "编辑服务 local", exact: true })).toHaveAttribute("aria-expanded", "true");
	await expect(local.getByLabel("服务名称", { exact: true })).toHaveValue("本地模型");
	expect(await readFile(file, "utf8")).toBe(saved);
});

test("表单显示实际默认值，修改及重置保留继承行为", async ({ gui: { page }, workspace: { agentDir } }) => {
	await open(page);
	const pane = services(page);
	await pane.getByRole("button", { name: "编辑服务 local", exact: true }).click();
	await pane.getByRole("button", { name: "编辑模型 base", exact: true }).click();
	const model = pane.getByRole("article", { name: "模型 base", exact: true });
	const field = (name: string) => model.getByRole("combobox", { name, exact: true });
	const toggle = (name: string) => model.getByRole("switch", { name, exact: true });
	const choose = async (name: string, value: string) => {
		await field(name).click();
		await page.getByRole("option", { name: value, exact: true }).click();
	};
	await expect(toggle("思考能力")).not.toBeChecked();
	await expect(model.getByRole("toolbar", { name: "输入类型", exact: true }).getByRole("button", { name: "文本", exact: true })).toHaveAttribute("aria-pressed", "true");
	await expect(model.getByRole("toolbar", { name: "输入类型", exact: true }).getByRole("button", { name: "图片", exact: true })).toHaveAttribute("aria-pressed", "false");
	await model.getByRole("button", { name: "协议与思考", exact: true }).click();
	await expect(field("思考格式")).toHaveText("openai");
	await expect(field("思考请求扩展")).toHaveCount(0);
	await expect(model.getByRole("radiogroup", { name: "输出上限字段", exact: true }).getByRole("radio", { name: "max_completion_tokens", exact: true })).toBeChecked();
	await expect(toggle("Developer 角色")).toBeChecked();
	await expect(toggle("服务端存储")).toBeChecked();
	await expect(toggle("独立 reasoning_effort 参数")).toBeChecked();
	await expect(settings(page).getByRole("button", { name: "保存", exact: true })).toBeDisabled();
	await toggle("服务端存储").uncheck();
	await model.getByRole("button", { name: "重置服务端存储", exact: true }).click();
	await expect(toggle("服务端存储")).toBeChecked();
	await expect(model.getByRole("button", { name: "重置服务端存储", exact: true })).toHaveCount(0);
	await choose("思考格式", "qwen");
	await pane.getByLabel("API 地址", { exact: true }).fill("https://api.deepseek.com/v1");
	await expect(field("思考格式")).toHaveText("qwen");
	await expect(model.getByRole("radiogroup", { name: "输出上限字段", exact: true }).getByRole("radio", { name: "max_tokens", exact: true })).toBeChecked();
	await expect(toggle("Developer 角色")).not.toBeChecked();
	await save(page);
	const file = path.join(agentDir, "models.json");
	expect(parse(await readFile(file, "utf8")).providers.local.models[0].compat.thinkingFormat).toBe("qwen");
	await model.getByRole("button", { name: "重置思考格式", exact: true }).click();
	await expect(field("思考格式")).toHaveText("deepseek");
	await save(page);
	const content = await readFile(file, "utf8");
	expect(content).toContain("// 保留注释");
	const saved = parse(content).providers.local.models[0];
	expect(saved).not.toHaveProperty("reasoning");
	expect(saved).not.toHaveProperty("input");
	expect(saved).not.toHaveProperty("compat.thinkingFormat");
});

test("开启思考能力后编辑映射，保留原生格式和模型覆盖层", async ({ gui: { page }, workspace: { agentDir } }) => {
	const file = path.join(agentDir, "models.json");
	await writeFile(file, JSON.stringify({ providers: { local: {
		api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "local",
		models: [], modelOverrides: { m: { maxTokens: 4096 } },
	} } }));
	await open(page);
	const pane = services(page);
	await pane.getByRole("button", { name: "编辑服务 local", exact: true }).click();
	await pane.getByRole("button", { name: "添加模型", exact: true }).click();
	await pane.getByLabel("模型 ID", { exact: true }).fill("m");
	await pane.getByRole("button", { name: "添加", exact: true }).click();
	const model = pane.getByRole("article", { name: "模型 m", exact: true });
	await expect(model.getByRole("switch", { name: "思考能力", exact: true })).not.toBeChecked();
	await model.getByRole("button", { name: "思考等级映射", exact: true }).click();
	await expect(model.getByRole("checkbox", { name: "在 opi 中启用 xhigh", exact: true })).toBeDisabled();
	await model.getByRole("switch", { name: "思考能力", exact: true }).check();
	await model.getByRole("checkbox", { name: "在 opi 中启用 xhigh", exact: true }).check();
	await model.getByRole("textbox", { name: "opi xhigh 对应的服务商值", exact: true }).fill("max");
	await model.getByRole("button", { name: "协议与思考", exact: true }).click();
	await model.getByRole("combobox", { name: "思考格式", exact: true }).click();
	await expect(page.getByRole("option")).toHaveText(THINKING_FORMATS);
	await page.getByRole("option", { name: "deepseek", exact: true }).click();
	await save(page);
	expect(parse(await readFile(file, "utf8")).providers.local).toMatchObject({
		models: [{ id: "m" }], modelOverrides: { m: { maxTokens: 4096, reasoning: true, compat: { thinkingFormat: "deepseek" }, thinkingLevelMap: { xhigh: "max" } } },
	});
});

test("思考映射表编辑服务商值，禁用、单项还原和整体还原正确保存", async ({ gui: { page }, workspace: { agentDir } }) => {
	const file = path.join(agentDir, "models.json");
	await writeFile(file, JSON.stringify({ providers: { local: {
		api: "openai-responses", baseUrl: "http://localhost:11451/v1", apiKey: "local", models: [{ id: "reasoner", reasoning: true }],
	} } }));
	await open(page);
	const pane = services(page);
	await pane.getByRole("button", { name: "编辑服务 local", exact: true }).click();
	await pane.getByRole("button", { name: "编辑模型 reasoner", exact: true }).click();
	const model = pane.getByRole("article", { name: "模型 reasoner", exact: true });
	await model.getByRole("button", { name: "思考等级映射", exact: true }).click();
	const table = model.getByRole("table", { name: "思考等级映射" });
	const enabled = (level: string) => table.getByRole("checkbox", { name: `在 opi 中启用 ${level}`, exact: true });
	const value = (level: string) => table.getByRole("textbox", { name: `opi ${level} 对应的服务商值`, exact: true });
	await expect(enabled("xhigh")).not.toBeChecked();
	await enabled("xhigh").check();
	await value("xhigh").fill("max");
	await expect(enabled("max")).not.toBeChecked();
	await enabled("minimal").uncheck();
	await expect(value("minimal")).toHaveCount(0);
	await value("off").fill("off");
	await table.getByRole("button", { name: "恢复 off 默认映射", exact: true }).click();
	await expect(value("off")).toHaveValue("");
	await expect(value("off")).toHaveAttribute("placeholder", "none");
	await save(page);
	expect(parse(await readFile(file, "utf8")).providers.local.models[0].thinkingLevelMap).toEqual({ xhigh: "max", minimal: null });
	const reset = table.getByRole("button", { name: "恢复默认映射", exact: true });
	await expect(reset).toBeVisible();
	await reset.click();
	await expect(enabled("minimal")).toBeChecked();
	await expect(enabled("xhigh")).not.toBeChecked();
	await save(page);
	expect(parse(await readFile(file, "utf8")).providers.local.models[0]).not.toHaveProperty("thinkingLevelMap");
});

test("思考模板联动映射、默认等级和 API 可用选项，切换后保留配置", async ({ gui: { page }, workspace: { agentDir } }) => {
	const file = path.join(agentDir, "models.json");
	await writeFile(file, JSON.stringify({ providers: { local: {
		api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "local", compat: { thinkingFormat: "qwen-chat-template" },
		models: [{ id: "m", reasoning: true, defaultThinkingLevel: "minimal", thinkingLevelMap: { high: "custom", minimal: null } }],
	} } }));
	await open(page);
	const pane = services(page);
	await pane.getByRole("button", { name: "编辑服务 local", exact: true }).click();
	await pane.getByRole("button", { name: "编辑模型 m", exact: true }).click();
	const model = pane.getByRole("article", { name: "模型 m", exact: true });
	await model.getByRole("button", { name: "协议与思考", exact: true }).click();
	await model.getByRole("button", { name: "思考等级映射", exact: true }).click();
	const table = model.getByRole("table", { name: "思考等级映射", exact: true });
	const effort = model.getByRole("switch", { name: "独立 reasoning_effort 参数", exact: true });
	await expect(table.getByRole("textbox")).toHaveCount(0);
	await expect(table).toContainText("开启思考");
	await expect(table).not.toContainText("custom");
	await expect(effort).toBeDisabled();
	await expect(model.getByText("已配置的等级当前不可选，运行时会自动调整。请改选或重置。", { exact: true })).toBeVisible();
	await model.getByRole("combobox", { name: "默认思考等级", exact: true }).click();
	for (const level of ["minimal", "xhigh", "max"]) await expect(page.getByRole("option", { name: level, exact: true })).toBeDisabled();
	await page.getByRole("option", { name: "high", exact: true }).click();
	await table.getByRole("checkbox", { name: "在 opi 中启用 xhigh", exact: true }).check();
	await selectSetting(page, "默认思考等级", "xhigh");
	await selectSetting(page, "API 协议", "openai-responses");
	await expect(model.getByRole("combobox", { name: "思考格式", exact: true })).toHaveCount(0);
	await expect(effort).toHaveCount(0);
	await expect(table.getByRole("textbox", { name: "opi high 对应的服务商值", exact: true })).toHaveValue("custom");
	await expect(table.getByRole("textbox", { name: "opi off 对应的服务商值", exact: true })).toHaveAttribute("placeholder", "none");
	await save(page);
	expect(parse(await readFile(file, "utf8")).providers.local).toMatchObject({ api: "openai-responses", compat: { thinkingFormat: "qwen-chat-template" }, models: [{
		id: "m", defaultThinkingLevel: "xhigh", thinkingLevelMap: { high: "custom", minimal: null, xhigh: "xhigh" },
	}] });
	await selectSetting(page, "API 协议", "openai-completions");
	await expect(model.getByRole("combobox", { name: "思考格式", exact: true })).toHaveText("qwen-chat-template");
	await expect(effort).toBeDisabled();
	await expect(table.getByRole("textbox")).toHaveCount(0);
});

test("原生思考格式切换保留模板参数，重置恢复继承", async ({ gui: { page }, workspace: { agentDir } }) => {
	const file = path.join(agentDir, "models.json");
	const inherited = { enable_thinking: { $var: "thinking.enabled" } };
	await writeFile(file, JSON.stringify({ providers: { local: {
		api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "local",
		compat: { thinkingFormat: "chat-template", chatTemplateKwargs: inherited, supportsReasoningEffort: false },
		models: [{ id: "m", reasoning: true, thinkingLevelMap: { high: "custom" } }],
	} } }));
	await open(page);
	const pane = services(page);
	await pane.getByRole("button", { name: "编辑服务 local", exact: true }).click();
	await pane.getByRole("button", { name: "编辑模型 m", exact: true }).click();
	const model = pane.getByRole("article", { name: "模型 m", exact: true });
	await model.getByRole("button", { name: "协议与思考", exact: true }).click();
	await model.getByRole("button", { name: "思考等级映射", exact: true }).click();
	const template = model.getByRole("group", { name: "chatTemplateKwargs", exact: true });
	const high = model.getByRole("textbox", { name: "opi high 对应的服务商值", exact: true });
	const format = model.getByRole("combobox", { name: "思考格式", exact: true });
	await expect(format).toHaveText("chat-template");
	await expect(template.getByRole("row", { name: "enable_thinking", exact: true })).toContainText("继承");
	await expect(high).toHaveCount(0);
	await template.getByRole("button", { name: "添加 reasoning_effort", exact: true }).click();
	await template.getByRole("button", { name: "编辑参数 reasoning_effort", exact: true }).click();
	const editor = page.getByRole("dialog", { name: "编辑参数 reasoning_effort", exact: true });
	await editor.getByRole("checkbox", { name: "omitWhenOff", exact: true }).check();
	await editor.getByRole("button", { name: "应用", exact: true }).click();
	const templateValue = { reasoning_effort: { $var: "thinking.effort", omitWhenOff: true } };
	await expect(template.getByRole("row", { name: "reasoning_effort", exact: true })).toContainText("omitWhenOff");
	await expect(high).toHaveValue("custom");
	await expect(model.getByRole("textbox", { name: "opi off 对应的服务商值", exact: true })).toHaveCount(0);
	for (const value of ["qwen-chat-template", "baseten"]) {
		await format.click();
		await expect(page.getByRole("option")).toHaveText(THINKING_FORMATS);
		await page.getByRole("option", { name: value, exact: true }).click();
		await expect(format).toHaveText(value);
		await expect(format).toBeEnabled();
		await expect(template).toHaveCount(0);
		await expect(high).toHaveCount(0);
		await expect(model.getByRole("combobox", { name: "思考请求扩展", exact: true })).toHaveCount(0);
		await format.click();
		await page.getByRole("option", { name: "chat-template", exact: true }).click();
		await expect(template).toBeVisible();
		await expect(template.getByRole("row", { name: "reasoning_effort", exact: true })).toContainText("thinking.effort");
		await expect(high).toHaveValue("custom");
	}
	await save(page);
	const saved = parse(await readFile(file, "utf8")).providers.local;
	expect(saved.models[0].compat).toEqual({ chatTemplateKwargs: templateValue });
	expect(saved.compat.chatTemplateKwargs).toEqual(inherited);
	await model.getByRole("button", { name: "重置chatTemplateKwargs", exact: true }).click();
	await expect(template.getByRole("row", { name: "reasoning_effort", exact: true })).toHaveCount(0);
	await expect(template.getByRole("row", { name: "enable_thinking", exact: true })).toContainText("继承");
	await expect(high).toHaveCount(0);
	await save(page);
	expect(parse(await readFile(file, "utf8")).providers.local.models[0]).not.toHaveProperty("compat.chatTemplateKwargs");
	await format.click();
	await page.getByRole("option", { name: "qwen-chat-template", exact: true }).click();
	await model.getByRole("button", { name: "重置思考格式", exact: true }).click();
	await expect(format).toHaveText("chat-template");
	await expect(template).toBeVisible();
	await expect(settings(page).getByRole("button", { name: "保存", exact: true })).toBeDisabled();
});

test("模板参数覆盖、重置和重命名可保存，关闭编辑器恢复焦点", async ({ gui: { page }, workspace: { agentDir } }) => {
	const file = path.join(agentDir, "models.json");
	const inherited = { enable_thinking: { $var: "thinking.enabled", omitWhenOff: true } };
	await writeFile(file, JSON.stringify({ providers: { local: {
		api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "local",
		compat: { thinkingFormat: "chat-template", chatTemplateKwargs: inherited }, models: [{ id: "m", reasoning: true }],
	} } }));
	await open(page);
	const pane = services(page);
	await pane.getByRole("button", { name: "编辑服务 local", exact: true }).click();
	await pane.getByRole("button", { name: "编辑模型 m", exact: true }).click();
	const model = pane.getByRole("article", { name: "模型 m", exact: true });
	const template = model.getByRole("group", { name: "chatTemplateKwargs", exact: true });
	const addButton = template.getByRole("button", { name: "添加参数", exact: true });
	const editor = page.getByRole("dialog", { name: "添加参数", exact: true });
	const chooseType = async (type: string) => {
		await page.getByRole("combobox", { name: "取值类型", exact: true }).click();
		await page.getByRole("option", { name: type, exact: true }).click();
	};
	await template.getByRole("button", { name: "编辑参数 enable_thinking", exact: true }).click();
	const inheritedEditor = page.getByRole("dialog", { name: "编辑参数 enable_thinking", exact: true });
	await expect(inheritedEditor.getByLabel("参数名", { exact: true })).toHaveAttribute("readonly", "");
	await inheritedEditor.getByRole("checkbox", { name: "omitWhenOff", exact: true }).uncheck();
	await inheritedEditor.getByRole("button", { name: "应用", exact: true }).click();
	await expect(template.getByRole("row", { name: "enable_thinking", exact: true })).not.toContainText("omitWhenOff");
	await save(page);
	expect(parse(await readFile(file, "utf8")).providers.local.models[0].compat.chatTemplateKwargs).toEqual({ enable_thinking: { $var: "thinking.enabled" } });
	await template.getByRole("button", { name: "重置参数 enable_thinking", exact: true }).click();
	await expect(template.getByRole("row", { name: "enable_thinking", exact: true })).toContainText("继承");

	await addButton.click();
	await editor.getByLabel("参数名", { exact: true }).fill("enable_thinking");
	await expect(editor.getByRole("alert")).toHaveText("参数名已存在");
	await expect(editor.getByRole("button", { name: "添加", exact: true })).toBeDisabled();
	await editor.getByLabel("参数名", { exact: true }).fill("scale");
	await chooseType("number");
	const number = editor.getByLabel("值", { exact: true });
	await number.fill("-");
	await expect(editor.getByRole("button", { name: "添加", exact: true })).toBeDisabled();
	await number.fill("-0.");
	await number.pressSequentially("25");
	await expect(number).toHaveValue("-0.25");
	await editor.getByRole("button", { name: "添加", exact: true }).click();
	await expect(addButton).toBeFocused();

	await template.getByRole("button", { name: "编辑参数 scale", exact: true }).click();
	const renameEditor = page.getByRole("dialog", { name: "编辑参数 scale", exact: true });
	await renameEditor.getByLabel("参数名", { exact: true }).fill("factor");
	await renameEditor.getByRole("button", { name: "应用", exact: true }).click();
	await expect(template.getByRole("button", { name: "编辑参数 factor", exact: true })).toBeFocused();
	for (const [name, type] of [["prefix", "string"], ["preserve_thinking", "boolean"], ["budget", "null"]] as const) {
		await addButton.click();
		await editor.getByLabel("参数名", { exact: true }).fill(name);
		await chooseType(type);
		await editor.getByRole("button", { name: "添加", exact: true }).click();
	}
	await save(page);
	const saved = parse(await readFile(file, "utf8")).providers.local;
	expect(saved.models[0].compat.chatTemplateKwargs).toEqual({ factor: -0.25, prefix: "", preserve_thinking: false, budget: null });
	expect(saved.compat.chatTemplateKwargs).toEqual(inherited);
});

test("模型 ID 输入筛选候选，也可直接添加自定义模型", async ({ gui: { page }, workspace: { agentDir } }) => {
	const requests: string[] = [];
	const server = createServer((req, res) => {
		requests.push(`${req.url} ${req.headers.authorization}`);
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ data: [{ id: "remote", context_length: 32768 }, { id: "remote:high" }] }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("目录服务器未启动");
	try {
		await open(page);
		const pane = services(page);
		await pane.getByRole("button", { name: "添加服务", exact: true }).click();
		await pane.getByLabel("服务 ID", { exact: true }).fill("catalog");
		await pane.getByRole("button", { name: "添加", exact: true }).click();
		const service = pane.getByRole("article", { name: "模型服务 catalog", exact: true });
		await service.getByLabel("API 地址", { exact: true }).fill(`http://127.0.0.1:${address.port}/v1`);
		await selectSetting(page, "API 协议", "openai-completions");
		await service.getByLabel("API Key", { exact: true }).fill("local");
		await save(page);
		await settings(page).getByRole("button", { name: "关闭面板", exact: true }).click();
		await open(page);
		await service.getByRole("button", { name: "编辑服务 catalog", exact: true }).click();
		await expect(service.getByText("待重载", { exact: true })).toBeVisible();
		await expect(service.getByText("请先保存并重载新服务，再获取候选模型", { exact: true })).toBeVisible();
		await settings(page).getByRole("button", { name: "关闭面板", exact: true }).click();
		if ((page.viewportSize()?.width ?? 1200) < 768) await page.getByRole("button", { name: "菜单", exact: true }).click();
		const reloaded = page.waitForResponse((response) => response.url().endsWith("/api/action") && response.request().postData()?.includes('"action":"reload"') === true);
		await page.getByRole("button", { name: "重载资源", exact: true }).click();
		expect((await reloaded).ok()).toBe(true);
		await open(page);
		const badge = service.getByRole("button", { name: "检测服务 catalog，已连接", exact: true });
		await expect(badge).toBeVisible();
		requests.length = 0;
		await badge.press("Enter");
		await expect.poll(() => requests.length).toBe(1);
		await expect(badge).toHaveText("已连接");
		await expect(service.getByRole("button", { name: "编辑服务 catalog", exact: true })).toHaveAttribute("aria-expanded", "false");
		await badge.hover();
		await expect(page.getByRole("tooltip")).toContainText("ms");
		await service.getByRole("button", { name: "编辑服务 catalog", exact: true }).click();
		await expect(service.getByRole("button", { name: "重新获取", exact: true })).toBeEnabled();
		await expect(service.getByText("0 个模型", { exact: true })).toBeVisible();
		const model = service.getByRole("article", { name: "模型 remote", exact: true });
		await expect(model).toHaveCount(0);
		const file = path.join(agentDir, "models.json");
		expect(parse(await readFile(file, "utf8")).providers.catalog).not.toHaveProperty("models");
		expect(requests).toContain("/v1/models Bearer local");
		await service.getByRole("button", { name: "添加模型", exact: true }).click();
		const input = service.getByRole("combobox", { name: "模型 ID", exact: true });
		const candidates = service.getByRole("listbox", { name: "模型 ID候选", exact: true });
		await expect(input).toHaveCount(1);
		await expect(candidates.getByRole("option")).toHaveCount(2);
		await input.fill(":HIGH");
		await expect(candidates.getByRole("option")).toHaveText(["remote:high"]);
		await input.press("ArrowDown");
		await expect(candidates.getByRole("option", { selected: true })).toHaveText("remote:high");
		await input.press("Enter");
		await expect(input).toHaveValue("remote:high");
		await expect(candidates).toHaveCount(0);
		await expect(service.getByRole("article", { name: "模型 remote:high", exact: true })).toHaveCount(0);
		await input.fill("REMOTE");
		await expect(candidates.getByRole("option")).toHaveCount(2);
		await input.press("Escape");
		await expect(candidates).toHaveCount(0);
		await expect(settings(page)).toBeVisible();
		await input.click();
		await expect(candidates.getByRole("option")).toHaveCount(2);
		await candidates.getByRole("option", { name: "remote", exact: true }).click();
		await expect(input).toHaveValue("remote");
		await expect(model).toHaveCount(0);
		await service.getByRole("button", { name: "添加", exact: true }).click();
		await expect(model).toBeVisible();
		await expect(model.getByLabel("上下文 Token", { exact: true })).toHaveValue("32768");
		await model.getByLabel("最大输出 Token", { exact: true }).fill("4096");
		await service.getByRole("button", { name: "添加模型", exact: true }).click();
		await expect(candidates.getByRole("option")).toHaveText(["remote:high"]);
		await input.fill("remote");
		await expect(service.getByRole("button", { name: "添加", exact: true })).toBeDisabled();
		await expect(service.getByRole("alert")).toHaveText("模型 ID已存在");
		await input.fill(" custom-id ");
		await expect(candidates).toHaveCount(0);
		await input.press("Enter");
		await expect(service.getByRole("article", { name: "模型 custom-id", exact: true })).toBeVisible();
		await service.getByRole("button", { name: "添加模型", exact: true }).click();
		await input.fill("remote:high");
		await service.getByRole("button", { name: "添加", exact: true }).click();
		const variant = service.getByRole("article", { name: "模型 remote:high", exact: true });
		await expect(variant).toBeVisible();
		await expect(variant.getByRole("switch", { name: "思考能力", exact: true })).not.toBeChecked();
		await save(page);
		expect(parse(await readFile(file, "utf8")).providers.catalog.models).toEqual([{ id: "remote", contextWindow: 32768, maxTokens: 4096 }, { id: "custom-id" }, { id: "remote:high" }]);
		await model.getByRole("button", { name: "删除模型 remote", exact: true }).click();
		await model.getByRole("button", { name: "确认删除模型 remote", exact: true }).click();
		await expect(model).toHaveCount(0);
		await save(page);
		expect(parse(await readFile(file, "utf8")).providers.catalog.models).toEqual([{ id: "custom-id" }, { id: "remote:high" }]);
	} finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("损坏配置可修复，冲突和非法字段保留草稿", async ({ gui: { page }, workspace: { agentDir } }) => {
	const file = path.join(agentDir, "models.json");
	const invalid = parse(original);
	invalid.providers.local.models[0].contextWindow = -1;
	const initial = JSON.stringify(invalid);
	await writeFile(file, initial);
	await open(page);
	const pane = services(page);
	const source = pane.getByLabel("模型服务 JSON");
	await expect(source).toHaveText(initial);
	const form = pane.getByRole("button", { name: "表单", exact: true });
	await expect(form).toBeDisabled();
	await source.fill("{");
	await expect(form).toBeDisabled();
	await expect(settings(page).getByRole("button", { name: "保存", exact: true })).toBeDisabled();
	await expect(pane.getByRole("button", { name: "编辑服务 local", exact: true })).toHaveCount(0);
	await source.fill(initial.replace('"contextWindow":-1', '"contextWindow":8192'));
	await pane.getByRole("button", { name: "表单", exact: true }).click();
	await pane.getByRole("button", { name: "编辑服务 local", exact: true }).click();
	await pane.getByRole("button", { name: "编辑模型 base", exact: true }).click();
	const tokens = pane.getByLabel("上下文 Token", { exact: true });
	await tokens.fill("-");
	await expect(tokens).toHaveValue("-");
	await expect(source).toHaveCount(0);
	await expect(settings(page).getByRole("button", { name: "保存", exact: true })).toBeDisabled();
	await tokens.fill("-1");
	await expect(tokens).toHaveValue("-1");
	await expect(source).toHaveCount(0);
	await pane.getByRole("button", { name: "JSON", exact: true }).click();
	await expect(source).toHaveText(initial);
	await expect(form).toBeDisabled();
	const repaired = parse(await source.innerText());
	repaired.providers.local.models[0].contextWindow = 8192;
	await source.fill(JSON.stringify(repaired));
	await form.click();
	await expect(tokens).toHaveValue("8192");
	await writeFile(file, '{"providers":{}}');
	await settings(page).getByRole("button", { name: "保存", exact: true }).click();
	await expect(settings(page).locator(".settings-actions").getByRole("alert")).toContainText("未保存");
	await expect(pane.getByLabel("上下文 Token", { exact: true })).toHaveValue("8192");
	expect(await readFile(file, "utf8")).toBe('{"providers":{}}');
	await settings(page).getByRole("button", { name: "放弃", exact: true }).click();
	await expect(source).toHaveText(initial);
	await expect(form).toBeDisabled();
});
