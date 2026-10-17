import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { parse } from "jsonc-parser";
import { test, expect } from "./fixture.ts";
import { selectSetting, selectSettingsCategory } from "./settings-steps.ts";

const settings = (page: Page) => page.getByRole("dialog", { name: "设置", exact: true });
const services = (page: Page) => settings(page).getByRole("region", { name: "OpenAI 兼容服务", exact: true });
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
	await expect(settings(page).locator(".settings-actions").getByRole("status")).toHaveText("已保存");
}
test.beforeEach(async ({ workspace: { agentDir } }) => { await writeFile(path.join(agentDir, "models.json"), original); });

test("编辑服务、增删模型和切换 JSON 共用草稿，保存与放弃不丢失其他配置", async ({ gui: { page }, workspace: { agentDir } }) => {
	const file = path.join(agentDir, "models.json");
	await open(page);
	const pane = services(page);
	await expect(pane.getByRole("article", { name: /^模型服务 / })).toHaveCount(1);
	await pane.getByRole("button", { name: "编辑服务 local", exact: true }).click();
	const local = pane.getByRole("article", { name: "模型服务 local", exact: true });
	await local.getByLabel("服务名称", { exact: true }).fill("本地模型");
	await local.getByLabel("API 地址", { exact: true }).fill("https://user:password@example.com/v1?key=secret");
	await expect(local.getByRole("button", { name: "编辑服务 local", exact: true })).toHaveText("本地模型local · example.com");
	await local.getByRole("button", { name: "添加模型", exact: true }).click();
	await local.getByLabel("模型 ID", { exact: true }).fill("reasoning-model");
	await local.getByRole("button", { name: "添加", exact: true }).click();
	const model = local.getByRole("article", { name: "模型 reasoning-model", exact: true });
	await model.getByLabel("上下文 Token", { exact: true }).fill("65536");
	await model.getByLabel("最大输出 Token", { exact: true }).fill("8192");
	await selectSetting(page, "输入类型", "文本与图片");
	await selectSetting(page, "思考能力", "开启");
	await selectSetting(page, "默认思考等级", "high");
	await model.getByRole("button", { name: "采样参数", exact: true }).click();
	await model.getByLabel("温度", { exact: true }).click();
	await model.getByLabel("温度", { exact: true }).pressSequentially("0.7");
	await expect(model.getByLabel("温度", { exact: true })).toHaveValue("0.7");
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
	expect(parse(await pane.getByLabel("模型服务 JSON").inputValue()).providers.local.models.map(({ id }: { id: string }) => id)).toEqual(["reasoning-model"]);
	await pane.getByRole("button", { name: "表单", exact: true }).click();
	await expect(base).toHaveCount(0);
	await save(page);
	const saved = await readFile(file, "utf8");
	expect(parse(saved).providers.local.models.map(({ id }: { id: string }) => id)).toEqual(["reasoning-model"]);
	await local.getByLabel("服务名称", { exact: true }).fill("未保存的名称");
	await settings(page).getByRole("button", { name: "放弃", exact: true }).click();
	await pane.getByRole("button", { name: "编辑服务 local", exact: true }).click();
	await expect(local.getByLabel("服务名称", { exact: true })).toHaveValue("本地模型");
	expect(await readFile(file, "utf8")).toBe(saved);
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
	await model.getByRole("button", { name: "恢复默认映射", exact: true }).click();
	await expect(enabled("minimal")).toBeChecked();
	await expect(enabled("xhigh")).not.toBeChecked();
	await save(page);
	expect(parse(await readFile(file, "utf8")).providers.local.models[0]).not.toHaveProperty("thinkingLevelMap");
});

test("新增发现服务须先重载，刷新后编辑模型只保存覆盖，还原不删除发现模型", async ({ gui: { page }, workspace: { agentDir } }) => {
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
		await pane.getByLabel("服务 ID", { exact: true }).fill("discovery");
		await pane.getByRole("button", { name: "添加", exact: true }).click();
		const service = pane.getByRole("article", { name: "模型服务 discovery", exact: true });
		await service.getByLabel("API 地址", { exact: true }).fill(`http://127.0.0.1:${address.port}/v1`);
		await service.getByLabel("API Key", { exact: true }).fill("local");
		await service.getByRole("switch", { name: "自动发现", exact: true }).check();
		await service.getByRole("button", { name: "协议与思考", exact: true }).click();
		await selectSetting(page, "思考编码", "模型后缀");
		await save(page);
		await settings(page).getByRole("button", { name: "关闭面板", exact: true }).click();
		await open(page);
		await service.getByRole("button", { name: "编辑服务 discovery", exact: true }).click();
		await expect(service.getByText("待重载", { exact: true })).toBeVisible();
		await expect(service.getByRole("button", { name: "刷新模型", exact: true })).toBeDisabled();
		await settings(page).getByRole("button", { name: "关闭面板", exact: true }).click();
		if ((page.viewportSize()?.width ?? 1200) < 768) await page.getByRole("button", { name: "菜单", exact: true }).click();
		const reloaded = page.waitForResponse((response) => response.url().endsWith("/api/action") && response.request().postData()?.includes('"action":"reload"') === true);
		await page.getByRole("button", { name: "重载资源", exact: true }).click();
		expect((await reloaded).ok()).toBe(true);
		await open(page);
		await service.getByRole("button", { name: "编辑服务 discovery", exact: true }).click();
		await service.getByRole("button", { name: "刷新模型", exact: true }).click();
		const model = service.getByRole("article", { name: "模型 remote", exact: true });
		await expect(model).toBeVisible();
		await expect(service.getByRole("article", { name: "模型 remote:high", exact: true })).toHaveCount(0);
		expect(requests).toContain("/v1/models Bearer local");
		await service.getByRole("button", { name: "编辑模型 remote", exact: true }).click();
		await service.getByRole("button", { name: "思考等级映射", exact: true }).click();
		const mapping = service.getByRole("table", { name: "思考等级映射" });
		await expect(mapping.getByText("remote:high", { exact: true })).toBeVisible();
		await mapping.getByRole("checkbox", { name: "在 opi 中启用 high", exact: true }).uncheck();
		await service.getByLabel("最大输出 Token", { exact: true }).fill("4096");
		await save(page);
		const file = path.join(agentDir, "models.json");
		const config = parse(await readFile(file, "utf8"));
		expect(config.providers.discovery.modelOverrides).toEqual({ remote: { maxTokens: 4096, thinkingLevelMap: { high: null } } });
		expect(config.providers.discovery).not.toHaveProperty("models");
		await model.getByRole("button", { name: "还原模型设置 remote", exact: true }).click();
		await expect(model).toBeVisible();
		await expect(model.getByLabel("最大输出 Token", { exact: true })).toHaveValue("");
		await expect(mapping.getByRole("checkbox", { name: "在 opi 中启用 high", exact: true })).toBeChecked();
		await save(page);
		expect(parse(await readFile(file, "utf8")).providers.discovery.modelOverrides).not.toHaveProperty("remote");
	} finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("损坏配置可修复，冲突和非法字段保留草稿", async ({ gui: { page }, workspace: { agentDir } }) => {
	const file = path.join(agentDir, "models.json");
	await writeFile(file, "{");
	await open(page);
	const pane = services(page);
	const source = pane.getByLabel("模型服务 JSON");
	await expect(source).toHaveValue("{");
	await source.fill(original);
	await pane.getByRole("button", { name: "表单", exact: true }).click();
	await pane.getByRole("button", { name: "编辑服务 local", exact: true }).click();
	await pane.getByRole("button", { name: "请求设置", exact: true }).click();
	await pane.getByLabel("重试次数", { exact: true }).fill("-1");
	await expect(settings(page).getByRole("button", { name: "保存", exact: true })).toBeDisabled();
	await pane.getByLabel("重试次数", { exact: true }).fill("0");
	await writeFile(file, '{"providers":{}}');
	await settings(page).getByRole("button", { name: "保存", exact: true }).click();
	await expect(settings(page).locator(".settings-actions").getByRole("alert")).toContainText("未保存");
	await expect(pane.getByLabel("重试次数", { exact: true })).toHaveValue("0");
	expect(await readFile(file, "utf8")).toBe('{"providers":{}}');
	await settings(page).getByRole("button", { name: "放弃", exact: true }).click();
	await expect(source).toHaveValue("{");
});
