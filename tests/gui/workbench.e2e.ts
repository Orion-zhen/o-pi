import { test, expect } from "./fixture.ts";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { clickRowAction } from "./row-actions.ts";

test.beforeEach(async ({ workspace: { cwd } }) => {
	const git = (...args: string[]) => promisify(execFile)("git", args, { cwd });
	await git("init", "-b", "main");
	await git("config", "user.name", "GUI Test");
	await git("config", "user.email", "gui@example.invalid");
	await mkdir(path.join(cwd, "src"));
	await writeFile(path.join(cwd, "src", "main.ts"), "export const answer = 1;\n");
	await writeFile(path.join(cwd, "deleted.txt"), "deleted content\n");
	await git("add", ".");
	await git("commit", "-m", "initial");
	await writeFile(path.join(cwd, "src", "main.ts"), "export const answer = 42;\n");
	await rm(path.join(cwd, "deleted.txt"));
	await writeFile(path.join(cwd, "引用 空格.md"), "# 项目\n");
});

test("折叠父目录后不刷新隐藏后代，重新展开读取外部修改", async ({ gui: { page }, workspace: { cwd } }, info) => {
	await mkdir(path.join(cwd, "src", "deep"));
	await writeFile(path.join(cwd, "src", "deep", "first.ts"), "first\n");
	const phone = info.project.name === "phone";
	if (phone) {
		await page.getByRole("button", { name: "菜单", exact: true }).click();
		await page.locator(".mobile-sidebar .workbench-pane-tabs").getByRole("button", { name: "文件", exact: true }).click();
	}
	const navigation = page.locator(phone ? ".mobile-sidebar" : ".sidebar");
	const tree = navigation.getByRole("tree", { name: "工作区文件", exact: true });
	const src = tree.getByRole("treeitem", { name: "src", exact: true });
	await src.click();
	await tree.getByRole("treeitem", { name: "src/deep", exact: true }).click();
	await expect(tree.getByRole("treeitem", { name: "src/deep/first.ts", exact: true })).toBeVisible();
	await src.click();
	await expect(src).toHaveAttribute("aria-expanded", "false");
	const paths: unknown[] = [];
	await page.route("**/api/query", async (route) => {
		const body: unknown = route.request().postDataJSON().value;
		if (typeof body === "object" && body !== null && "query" in body && body.query === "workspaceFiles" && "path" in body) paths.push(body.path);
		await route.continue();
	});
	const response = page.waitForResponse((response) => {
		if (!response.url().endsWith("/api/query")) return false;
		const body: unknown = response.request().postDataJSON().value;
		return typeof body === "object" && body !== null && "query" in body && body.query === "workspaceFiles";
	});
	await navigation.getByRole("button", { name: "刷新文件", exact: true }).click();
	await response;
	expect(paths).toEqual([""]);
	await writeFile(path.join(cwd, "src", "deep", "external.ts"), "external change\n");
	await src.click();
	await expect(tree.getByRole("treeitem", { name: "src/deep/external.ts", exact: true })).toBeVisible();
	expect(paths).toContain("src/deep");
});

test("浏览文件、读取 Git 差异并引用路径", async ({ gui: { page } }, info) => {
	const phone = info.project.name === "phone";
	const openFiles = async () => {
		if (phone) {
			await page.getByRole("button", { name: "菜单", exact: true }).click();
			await page.locator(".mobile-sidebar .workbench-pane-tabs").getByRole("button", { name: "文件", exact: true }).click();
		}
	};
	await openFiles();
	const navigation = page.locator(phone ? ".mobile-sidebar" : ".sidebar");
	const tree = navigation.getByRole("tree", { name: "工作区文件", exact: true });
	await tree.getByRole("treeitem", { name: "src", exact: true }).click();
	await tree.getByRole("treeitem", { name: "src/main.ts", exact: true }).click();
	const preview = page.getByRole("complementary", { name: "会话信息", exact: true });
	await expect(preview.locator(".file-preview-body")).toContainText("-export const answer = 1;");
	await preview.getByRole("button", { name: "内容", exact: true }).click();
	await expect(preview.locator(".file-preview-body")).toContainText("export const answer = 42;");
	await expect(preview.locator(".file-preview-body")).not.toContainText("-export const answer = 1;");
	await openFiles();
	await navigation.getByRole("button", { name: "显示文件变更", exact: true }).click();
	const changes = navigation.getByRole("list", { name: "工作区变更", exact: true });
	await expect(changes.getByRole("button", { name: "deleted.txt", exact: true })).toBeVisible();
	await clickRowAction(changes.getByRole("button", { name: "引用路径 引用 空格.md", exact: true }));
	await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue('@"引用 空格.md" ');
	await expect(page.locator(".message.user")).toHaveCount(0);
});
