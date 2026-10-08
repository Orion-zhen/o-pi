import { configureModel } from "./model-fixture.ts";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test, expect } from "./fixture.ts";
import { startModelServer } from "../cli/model-server.ts";

let model: Awaited<ReturnType<typeof startModelServer>>;
test.beforeEach(async ({ workspace: { cwd, agentDir } }) => {
	await mkdir(path.join(cwd, "src"));
	await writeFile(path.join(cwd, "src/main.ts"), "export const answer = 42;\n");
	await writeFile(path.join(cwd, "README.md"), "# 文件链接预览\n");
	await writeFile(path.join(cwd, "引用 空格.md"), "中文和空格文件名\n");
	const text = [
		"[相对路径](src/main.ts#L42)",
		`[绝对路径](${path.join(cwd, "README.md")}:1)`,
		`[文件 URI](${pathToFileURL(path.join(cwd, "引用 空格.md")).href})`,
		"[不存在](missing.ts)",
		"[越界](../secret.txt)",
		"[网站](https://example.invalid/document)",
		"`src/main.ts`",
	].join("\n\n");
	model = await startModelServer(() => ({ text }));
	await configureModel(agentDir, model.url, "file-links-test");
	await writeFile(path.join(agentDir, "configs", "auto-title.jsonc"), '{"enabled":false}');
});
test.afterEach(async () => { await model?.close(); });

test("聊天文件链接打开右侧文件预览，刷新后仍可用且网页链接不受影响", async ({ gui: { page } }) => {
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("输出文件链接");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	const reply = page.locator('.assistant-reply[data-state="completed"]');
	await expect(reply).toContainText("文件 URI");
	await expect(reply.getByRole("link", { name: "越界", exact: true })).toHaveCount(0);
	const url = page.url();
	const sidebar = page.getByRole("complementary", { name: "会话信息", exact: true });
	for (const [label, name, content] of [
		["相对路径", "main.ts", "export const answer = 42;"],
		["绝对路径", "README.md", "# 文件链接预览"],
		["文件 URI", "引用 空格.md", "中文和空格文件名"],
	] as const) {
		await reply.getByRole("link", { name: label, exact: true }).click();
		await expect(sidebar).toHaveAttribute("data-open", "true");
		await expect(sidebar.getByRole("tab", { name: "文件", exact: true })).toHaveAttribute("aria-selected", "true");
		await expect(sidebar.locator(".file-preview-path")).toHaveText(name);
		await expect(sidebar.getByLabel("文件内容", { exact: true })).toContainText(content);
		expect(page.url()).toBe(url);
		expect(page.context().pages()).toHaveLength(1);
		if (label === "相对路径") await sidebar.getByRole("tab", { name: "会话统计", exact: true }).click();
		else await page.getByRole("button", { name: "收起会话信息", exact: true }).click();
	}
	await reply.getByRole("link", { name: "不存在", exact: true }).click();
	await expect(sidebar.getByRole("alert")).toContainText("ENOENT");
	expect(page.url()).toBe(url);
	await page.reload();
	await reply.getByRole("link", { name: "相对路径", exact: true }).click();
	await expect(sidebar.getByLabel("文件内容", { exact: true })).toContainText("export const answer = 42;");
	await page.getByRole("button", { name: "收起会话信息", exact: true }).click();
	await page.context().route("https://example.invalid/document", (route) => route.fulfill({ contentType: "text/html", body: "<p>External page</p>" }));
	const opened = page.waitForEvent("popup");
	await reply.getByRole("link", { name: "网站", exact: true }).click();
	const external = await opened;
	await expect(external).toHaveURL("https://example.invalid/document");
	await external.close();
	expect(page.url()).toBe(url);
});
