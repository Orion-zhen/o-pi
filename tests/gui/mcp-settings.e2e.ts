import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixture.ts";
import { selectSetting, selectSettingsCategory } from "./settings-steps.ts";

const original = {
	autoEnableCodemode: false, custom: { keep: true },
	mcpServers: { docs: { url: "https://example.com/private?token=not-in-summary", enabled: false,
		headers: { Authorization: "Bearer ${DOCS_TOKEN}" }, oauth: { clientId: "keep", custom: "keep" }, extra: [1, 2] } },
};
const settings = (page: Page) => page.getByRole("dialog", { name: "设置", exact: true });
const mcp = (page: Page) => settings(page).getByRole("region", { name: "MCP 服务", exact: true });
const form = (page: Page) => mcp(page).locator('.mcp-server[data-state="open"]');
async function open(page: Page) {
	if ((page.viewportSize()?.width ?? 1200) < 768) await page.getByRole("button", { name: "菜单", exact: true }).click();
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await selectSettingsCategory(page, "连接与集成");
}

test.beforeEach(async ({ workspace: { agentDir } }) => {
	await writeFile(path.join(agentDir, "mcp.json"), JSON.stringify(original));
});

test("服务行使用开关、组件折叠与直接图标操作，复用两步和快捷删除", async ({ gui: { page }, workspace: { agentDir } }) => {
	await open(page);
	const row = mcp(page).getByRole("article", { name: "MCP 服务 docs", exact: true });
	const enabled = row.getByRole("switch", { name: "启用 docs", exact: true });
	await expect(enabled).not.toBeChecked();
	await enabled.click();
	await expect(enabled).toBeChecked();
	await expect(row.getByRole("button", { name: /更多操作/ })).toHaveCount(0);
	const spacing = await row.locator(".mcp-server-actions").evaluate((element) => {
		const toggle = element.querySelector('[data-slot="switch"]');
		const [copy, remove] = element.querySelectorAll('button > svg');
		if (!toggle || !copy || !remove) throw new Error("缺少服务操作按钮");
		return {
			toggle: copy.getBoundingClientRect().left - toggle.getBoundingClientRect().right,
			icons: remove.getBoundingClientRect().left - copy.getBoundingClientRect().right,
		};
	});
	expect(Math.abs(spacing.toggle - spacing.icons)).toBeLessThan(2);
	await row.screenshot({ path: test.info().outputPath("mcp-row-spacing.png"), animations: "disabled" });
	await row.getByRole("button", { name: "编辑 docs", exact: true }).click();
	const content = row.locator(':scope > [data-slot="collapsible-content"]');
	await expect(content).toHaveAttribute("data-state", "open");
	await expect(content.locator(":scope > .collapse-content")).toHaveCSS("transition-property", /grid-template-rows/);
	await row.getByRole("button", { name: "收起 docs", exact: true }).click();
	await expect(content).toHaveAttribute("inert", "");
	await expect(content.locator(":scope > .collapse-content")).toBeHidden();
	await row.getByRole("button", { name: "复制服务 docs", exact: true }).click();
	const copy = mcp(page).getByRole("article", { name: "MCP 服务 docs-copy", exact: true });
	await expect(copy).toBeVisible();
	await copy.getByRole("button", { name: "删除服务 docs-copy", exact: true }).click();
	const confirm = copy.getByRole("button", { name: "确认删除服务 docs-copy", exact: true });
	await expect(confirm).toBeVisible();
	await confirm.press("Escape");
	await expect(copy.getByRole("button", { name: "删除服务 docs-copy", exact: true })).toBeVisible();
	await copy.getByRole("button", { name: "删除服务 docs-copy", exact: true }).click();
	await confirm.click();
	await expect(copy).toHaveCount(0);
	await row.getByRole("button", { name: "删除服务 docs", exact: true }).click({ modifiers: ["ControlOrMeta"] });
	await expect(row).toHaveCount(0);
	expect(JSON.parse(await readFile(path.join(agentDir, "mcp.json"), "utf8"))).toEqual(original);
});

test("参数和环境变量逐行动画增删，删除首项不替换后续行", async ({ gui: { page }, workspace: { agentDir } }) => {
	await open(page);
	await mcp(page).getByRole("button", { name: "添加服务", exact: true }).click();
	await form(page).getByLabel("服务名称", { exact: true }).fill("animated");
	await form(page).getByLabel("启动程序", { exact: true }).fill("node");
	const addAnimatedRow = async (label: string, selector: string) => {
		const button = form(page).getByRole("button", { name: label, exact: true });
		const sampling = button.evaluate((element, selector) => new Promise<{ opacity: number; height: number }[]>((resolve, reject) => {
			element.addEventListener("click", () => {
				const start = performance.now();
				const frames: { opacity: number; height: number }[] = [];
				const sample = () => {
					const rows = element.parentElement?.querySelectorAll(selector);
					const row = rows?.item(rows.length - 1)?.parentElement;
					if (row) {
						const opacity = Number(getComputedStyle(row).opacity);
						frames.push({ opacity, height: row.getBoundingClientRect().height });
						if (opacity === 1) { resolve(frames); return; }
					}
					if (performance.now() - start > 2000) { reject(new Error("行展开动画未完成")); return; }
					requestAnimationFrame(sample);
				};
				requestAnimationFrame(sample);
			}, { once: true });
		}), selector);
		const [frames] = await Promise.all([sampling, button.click()]);
		expect(frames.some(({ opacity }) => opacity > 0 && opacity < 1)).toBe(true);
		const height = frames.at(-1)?.height ?? 0;
		expect(frames.some((frame) => frame.height > 0 && frame.height < height - 1)).toBe(true);
	};
	await addAnimatedRow("添加参数", ".mcp-arg");
	await form(page).getByRole("textbox", { name: "启动参数 1", exact: true }).fill("first");
	await addAnimatedRow("添加参数", ".mcp-arg");
	await form(page).getByRole("textbox", { name: "启动参数 2", exact: true }).fill("second");
	await form(page).getByRole("textbox", { name: "启动参数 2", exact: true }).evaluate((element) => element.setAttribute("data-original-row", "second"));
	await form(page).getByRole("button", { name: "删除启动参数 1", exact: true }).click();
	await expect(form(page).getByRole("textbox", { name: "启动参数 1", exact: true })).toHaveValue("second");
	await expect(form(page).getByRole("textbox", { name: "启动参数 1", exact: true })).toHaveAttribute("data-original-row", "second");
	await addAnimatedRow("添加环境变量", ".mcp-pair");
	await form(page).getByLabel("环境变量名称 1", { exact: true }).fill("KEY");
	await form(page).getByLabel("环境变量值 1", { exact: true }).fill("${ENV_KEY}");
	await addAnimatedRow("添加环境变量", ".mcp-pair");
	await form(page).getByRole("button", { name: "删除环境变量 2", exact: true }).click();
	await settings(page).getByRole("button", { name: "保存", exact: true }).click();
	await expect(settings(page).getByRole("status")).toHaveText("已保存");
	const stored = JSON.parse(await readFile(path.join(agentDir, "mcp.json"), "utf8"));
	expect(stored.mcpServers.animated).toEqual({ command: "node", args: ["second"], env: { KEY: "${ENV_KEY}" } });
});

test("表单添加本地服务、字段校验、跨分类草稿与无损保存", async ({ gui: { page }, workspace: { agentDir } }) => {
	const file = path.join(agentDir, "mcp.json");
	await open(page);
	const save = settings(page).getByRole("button", { name: "保存", exact: true });
	await expect(mcp(page).getByRole("textbox", { name: "全局 MCP JSON" })).toHaveCount(0);
	await expect(mcp(page).locator(".mcp-server-address")).toHaveText("example.com");
	await expect(save).toBeDisabled();
	await mcp(page).getByRole("button", { name: "添加服务", exact: true }).click();
	await form(page).getByLabel("服务名称", { exact: true }).fill("filesystem");
	await mcp(page).getByRole("button", { name: "粘贴启动命令", exact: true }).click();
	await form(page).getByLabel("完整启动命令").fill('npx -y server-package "path with spaces"');
	await mcp(page).getByRole("button", { name: "拆分到表单", exact: true }).click();
	await expect(form(page).getByLabel("启动程序", { exact: true })).toHaveValue("npx");
	await expect(form(page).getByLabel("启动参数 3", { exact: true })).toHaveValue("path with spaces");
	await mcp(page).getByRole("button", { name: "添加环境变量", exact: true }).click();
	await form(page).getByLabel("环境变量名称 1", { exact: true }).fill("TOKEN");
	await form(page).getByLabel("环境变量值 1", { exact: true }).fill("${LOCAL_TOKEN}");
	await expect(form(page).getByLabel("环境变量值 1", { exact: true })).toHaveAttribute("type", "password");
	await mcp(page).getByRole("button", { name: "添加环境变量", exact: true }).click();
	await form(page).getByLabel("环境变量名称 2", { exact: true }).fill("TOKEN");
	await expect(save).toBeDisabled();
	await expect(mcp(page).getByRole("button", { name: "JSON", exact: true })).toBeDisabled();
	await mcp(page).getByRole("button", { name: "删除环境变量 2", exact: true }).click();
	await mcp(page).getByRole("button", { name: "工具与高级设置", exact: true }).click();
	await form(page).getByLabel("请求超时（秒）", { exact: true }).click();
	await form(page).getByLabel("请求超时（秒）", { exact: true }).pressSequentially("1.5");
	await expect(form(page).getByLabel("请求超时（秒）", { exact: true })).toHaveValue("1.5");
	await form(page).getByLabel("服务名称", { exact: true }).fill("docs");
	await expect(save).toBeDisabled();
	await form(page).getByLabel("服务名称", { exact: true }).fill("filesystem");
	await selectSettingsCategory(page, "外观");
	await selectSettingsCategory(page, "连接与集成");
	await expect(form(page).getByLabel("启动程序", { exact: true })).toHaveValue("npx");
	expect(JSON.parse(await readFile(file, "utf8"))).toEqual(original);
	await save.click();
	await expect(save).toBeDisabled();
	expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ ...original, mcpServers: { ...original.mcpServers,
		filesystem: { command: "npx", args: ["-y", "server-package", "path with spaces"], env: { TOKEN: "${LOCAL_TOKEN}" }, timeout: 1.5 },
	} });
	await mcp(page).getByRole("button", { name: "编辑 docs", exact: true }).click();
	await expect(form(page).getByLabel("Bearer Token", { exact: true })).toHaveValue("${DOCS_TOKEN}");
	await expect(form(page).getByLabel("Bearer Token", { exact: true })).toHaveAttribute("type", "password");
	await expect(settings(page).getByRole("status")).toHaveText("已保存");
	await expect(save).toBeDisabled();
	await form(page).getByLabel("Bearer Token", { exact: true }).scrollIntoViewIfNeeded();
	await mcp(page).evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)));
	await expect(mcp(page).evaluate((element) => element.scrollWidth <= element.clientWidth)).resolves.toBe(true);
	await page.screenshot({ path: test.info().outputPath("mcp-settings.png"), fullPage: true });
});

test("批量导入显式确认替换，复制、删除与放弃都只修改草稿", async ({ gui: { page }, workspace: { agentDir } }) => {
	const file = path.join(agentDir, "mcp.json");
	await open(page);
	await mcp(page).getByRole("button", { name: "导入配置", exact: true }).click();
	await mcp(page).getByLabel("导入 MCP JSON").fill(JSON.stringify({ autoEnableCodemode: true, mcpServers: {
		docs: { url: "https://new.example/mcp", enabled: false }, "docs-copy": { command: "uvx", args: ["server"], enabled: false },
	} }));
	await mcp(page).getByRole("button", { name: "预览导入", exact: true }).click();
	await expect(mcp(page).getByRole("button", { name: "导入到草稿", exact: true })).toBeDisabled();
	await mcp(page).getByRole("checkbox", { name: "替换 docs", exact: true }).check();
	await mcp(page).getByRole("button", { name: "导入到草稿", exact: true }).click();
	await mcp(page).getByRole("button", { name: "复制服务 docs", exact: true }).click();
	await expect(form(page).getByLabel("服务名称", { exact: true })).toHaveValue("docs-copy-2");
	await mcp(page).getByRole("button", { name: "删除服务 docs-copy", exact: true }).click();
	await mcp(page).getByRole("button", { name: "确认删除服务 docs-copy", exact: true }).click();
	expect(JSON.parse(await readFile(file, "utf8"))).toEqual(original);
	await settings(page).getByRole("button", { name: "放弃", exact: true }).click();
	await expect(mcp(page).getByRole("article")).toHaveCount(1);
	await mcp(page).getByRole("button", { name: "编辑 docs", exact: true }).click();
	await selectSetting(page, "认证方式", "已登录的提供商");
	await form(page).getByLabel("提供商名称", { exact: true }).fill("provider");
	await form(page).getByLabel("服务地址", { exact: true }).fill("http://example.com/mcp");
	const save = settings(page).getByRole("button", { name: "保存", exact: true });
	await expect(save).toBeDisabled();
	await form(page).getByLabel("服务地址", { exact: true }).fill("https://example.com/mcp");
	await save.click();
	await expect(save).toBeDisabled();
	const saved = JSON.parse(await readFile(file, "utf8"));
	expect(saved.autoEnableCodemode).toBe(false);
	expect(saved.mcpServers.docs).toMatchObject({ auth: { provider: "provider" }, headers: {}, oauth: original.mcpServers.docs.oauth });
});

test("新建远程服务，编辑认证头、OAuth 和有序工具规则", async ({ gui: { page }, workspace: { agentDir } }) => {
	await open(page);
	await mcp(page).getByRole("button", { name: "添加服务", exact: true }).click();
	await form(page).getByLabel("服务名称", { exact: true }).fill("remote");
	await selectSetting(page, "连接方式", "远程 HTTP");
	await form(page).getByLabel("服务地址", { exact: true }).fill("https://remote.example/mcp");
	await mcp(page).getByRole("switch", { name: "启用 remote", exact: true }).uncheck();
	await selectSetting(page, "认证方式", "Bearer Token");
	await form(page).getByLabel("Bearer Token", { exact: true }).fill("${REMOTE_TOKEN}");
	await mcp(page).getByRole("button", { name: "自定义请求头", exact: true }).click();
	await mcp(page).getByRole("button", { name: "添加请求头", exact: true }).click();
	await form(page).getByLabel("请求头名称 1", { exact: true }).fill("X-Region");
	await form(page).getByLabel("请求头值 1", { exact: true }).fill("local");
	await selectSetting(page, "认证方式", "自定义认证头");
	await form(page).getByLabel("请求头名称 2", { exact: true }).fill("X-API-Key");
	await form(page).getByLabel("请求头值 2", { exact: true }).fill("${API_KEY}");
	await expect(mcp(page).getByRole("combobox", { name: "认证方式", exact: true })).toHaveText("自定义认证头");
	await mcp(page).getByRole("button", { name: "OAuth 高级设置", exact: true }).click();
	await form(page).getByLabel("回调端口", { exact: true }).fill("0");
	const save = settings(page).getByRole("button", { name: "保存", exact: true });
	await expect(save).toBeDisabled();
	await form(page).getByLabel("回调端口", { exact: true }).fill("8765");
	await form(page).getByLabel("客户端密钥", { exact: true }).fill("${CLIENT_SECRET}");
	await mcp(page).getByRole("button", { name: "工具与高级设置", exact: true }).click();
	await mcp(page).getByRole("button", { name: "添加工具规则", exact: true }).click();
	await form(page).getByLabel("工具规则名称 1", { exact: true }).fill("get_*");
	await selectSetting(page, "工具规则方式 1", "搜索后加载");
	await mcp(page).getByRole("button", { name: "添加工具规则", exact: true }).click();
	await form(page).getByLabel("工具规则名称 2", { exact: true }).fill("*");
	await selectSetting(page, "工具规则方式 2", "隐藏");
	await mcp(page).getByRole("button", { name: "上移规则 2", exact: true }).click();
	await save.click();
	await expect(save).toBeDisabled();
	const saved = JSON.parse(await readFile(path.join(agentDir, "mcp.json"), "utf8"));
	expect(saved.mcpServers.remote).toEqual({ type: "http", url: "https://remote.example/mcp", enabled: false,
		headers: { "X-Region": "local", "X-API-Key": "${API_KEY}" }, oauth: { callbackPort: 8765, clientSecret: "${CLIENT_SECRET}" },
		toolExposure: { "*": "hidden", "get_*": "deferred" },
	});
	expect(Object.keys(saved.mcpServers.remote.toolExposure)).toEqual(["*", "get_*"]);
});

test("重新添加相同键值不产生修改，切换视图保留 JSON 原文", async ({ gui: { page }, workspace: { agentDir } }) => {
	const content = '{ "mcpServers": { "local": { "command": "node", "env": { "KEY": "value" } } } }';
	await writeFile(path.join(agentDir, "mcp.json"), content);
	await open(page);
	await mcp(page).getByRole("button", { name: "编辑 local", exact: true }).click();
	await form(page).getByRole("button", { name: "删除环境变量 1", exact: true }).click();
	await form(page).getByRole("button", { name: "添加环境变量", exact: true }).click();
	await form(page).getByLabel("环境变量名称 1", { exact: true }).fill("KEY");
	await form(page).getByLabel("环境变量值 1", { exact: true }).fill("value");
	await expect(settings(page).getByRole("button", { name: "保存", exact: true })).toBeDisabled();
	await mcp(page).getByRole("button", { name: "JSON", exact: true }).click();
	await expect(mcp(page).getByLabel("全局 MCP JSON", { exact: true })).toHaveValue(content);
	const edited = `\n${content}\n`;
	await mcp(page).getByLabel("全局 MCP JSON", { exact: true }).fill(edited);
	await mcp(page).getByRole("button", { name: "表单", exact: true }).click();
	await mcp(page).getByRole("button", { name: "JSON", exact: true }).click();
	await expect(mcp(page).getByLabel("全局 MCP JSON", { exact: true })).toHaveValue(edited);
});

test("导入替换已展开的服务时重新初始化认证编辑模式", async ({ gui: { page }, workspace: { agentDir } }) => {
	await writeFile(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
		docs: { url: "https://example.com/mcp", enabled: false, headers: { "X-API-Key": "old" } },
	} }));
	await open(page);
	await mcp(page).getByRole("button", { name: "编辑 docs", exact: true }).click();
	await expect(form(page).getByRole("combobox", { name: "认证方式", exact: true })).toHaveText("自定义认证头");
	await mcp(page).getByRole("button", { name: "导入配置", exact: true }).click();
	await mcp(page).getByLabel("导入 MCP JSON").fill(JSON.stringify({ mcpServers: {
		docs: { url: "https://example.com/mcp", enabled: false, headers: { Authorization: "Bearer new-token" } },
	} }));
	await mcp(page).getByRole("button", { name: "预览导入", exact: true }).click();
	await mcp(page).getByRole("checkbox", { name: "替换 docs", exact: true }).check();
	await mcp(page).getByRole("button", { name: "导入到草稿", exact: true }).click();
	await expect(form(page).getByRole("combobox", { name: "认证方式", exact: true })).toHaveText("Bearer Token");
	await expect(form(page).getByLabel("Bearer Token", { exact: true })).toHaveValue("new-token");
});

test("JSON 与表单使用相同校验，空文本不能绕过保存检查", async ({ gui: { page } }) => {
	await open(page);
	await mcp(page).getByRole("button", { name: "JSON", exact: true }).click();
	const source = mcp(page).getByLabel("全局 MCP JSON", { exact: true });
	const save = settings(page).getByRole("button", { name: "保存", exact: true });
	await source.fill(JSON.stringify({ mcpServers: { docs: {
		url: "https://example.com", headers: { Authorization: "one", authorization: "two" },
	} } }));
	await expect(save).toBeDisabled();
	await expect(mcp(page).getByRole("alert")).toContainText("不区分大小写");
	await mcp(page).getByRole("button", { name: "表单", exact: true }).click();
	await expect(save).toBeDisabled();
	await mcp(page).getByRole("button", { name: "编辑 docs", exact: true }).click();
	await expect(form(page).getByRole("alert").first()).toContainText("不区分大小写");
	await mcp(page).getByRole("button", { name: "JSON", exact: true }).click();
	await source.fill("");
	await expect(save).toBeDisabled();
	await expect(mcp(page).getByRole("button", { name: "表单", exact: true })).toBeDisabled();
	await expect(mcp(page).getByRole("alert")).toContainText("请使用 {} 清空配置");
	await source.fill("{}");
	await save.click();
	await expect(save).toBeDisabled();
	await expect(source).toHaveValue("{}");
});

test("空文件可以切换编辑视图，不产生未保存修改", async ({ gui: { page }, workspace: { agentDir } }) => {
	await writeFile(path.join(agentDir, "mcp.json"), "");
	await open(page);
	await mcp(page).getByRole("button", { name: "JSON", exact: true }).click();
	await expect(mcp(page).getByRole("alert")).toHaveCount(0);
	await expect(mcp(page).getByLabel("全局 MCP JSON", { exact: true })).toHaveValue("");
	await mcp(page).getByRole("button", { name: "表单", exact: true }).click();
	await expect(settings(page).getByRole("button", { name: "保存", exact: true })).toBeDisabled();
	await expect(mcp(page).getByRole("article")).toHaveCount(0);
});

test("共用草稿接口的普通 JSONC 设置仍能保存、放弃与重新读取", async ({ gui: { page } }) => {
	await open(page);
	await selectSettingsCategory(page, "工具与代码");
	const section = settings(page).getByRole("region", { name: "终端执行", exact: true });
	await section.getByRole("button", { name: "JSONC", exact: true }).click();
	const source = section.getByLabel("bashTool 全局 JSONC", { exact: true });
	const content = '{ "default_timeout_seconds": 42 }';
	await source.fill(content);
	const save = settings(page).getByRole("button", { name: "保存", exact: true });
	await save.click();
	await expect(save).toBeDisabled();
	await source.fill('{"default_timeout_seconds":43}');
	await settings(page).getByRole("button", { name: "放弃", exact: true }).click();
	await expect(source).toHaveValue(content);
	await settings(page).getByRole("button", { name: "关闭面板", exact: true }).click();
	await page.reload();
	await open(page);
	await selectSettingsCategory(page, "工具与代码");
	await section.getByRole("button", { name: "JSONC", exact: true }).click();
	await expect(source).toHaveValue(content);
	await expect(save).toBeDisabled();
});

test("损坏 JSON 可修复，外部修改冲突不丢失表单草稿", async ({ gui: { page }, workspace: { agentDir } }) => {
	const file = path.join(agentDir, "mcp.json");
	await writeFile(file, "{");
	await open(page);
	const source = mcp(page).getByLabel("全局 MCP JSON", { exact: true });
	await expect(source).toHaveValue("{");
	await source.fill(JSON.stringify(original));
	await mcp(page).getByRole("button", { name: "表单", exact: true }).click();
	await mcp(page).getByRole("button", { name: "编辑 docs", exact: true }).click();
	await form(page).getByLabel("服务地址", { exact: true }).fill("https://edited.example/mcp");
	await writeFile(file, "{}");
	await settings(page).getByRole("button", { name: "保存", exact: true }).click();
	await expect(settings(page).locator(".settings-actions").getByRole("alert")).toContainText("未保存");
	await expect(form(page).getByLabel("服务地址", { exact: true })).toHaveValue("https://edited.example/mcp");
	expect(await readFile(file, "utf8")).toBe("{}");
	await mcp(page).getByRole("button", { name: "JSON", exact: true }).click();
	await expect(source).toHaveValue(/edited\.example/);
	await settings(page).getByRole("button", { name: "放弃", exact: true }).click();
	await expect(source).toHaveValue("{");
	expect(await readFile(file, "utf8")).toBe("{}");
});
