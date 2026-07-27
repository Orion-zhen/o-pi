import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildScopeInventory, createGlobPlan, type ScopeInventory } from "../../src/file-tools/grep/inventory.js";
import { FileToolsHost } from "../../src/file-tools/runtime/host.js";
import { isFailed } from "../../src/file-tools/shared/result.js";
import { createGrepTestContext, expectInventorySuccess, inventoryWorkspace } from "./grep-fixtures.js";

const testContext = createGrepTestContext();

describe("grep ScopeInventory", () => {
	it.each([
		["/src/*.ts"],
		["../src/*.ts"],
		["src/../*.ts"],
		["C:/src/*.ts"],
		["src/\0*.ts"],
	] as const)("拒绝越出 scope 的 glob：%s", (glob) => {
		expect(createGlobPlan(glob)).toMatchObject({ status: "failed", error: { code: "INVALID_PATH" } });
	});

	it("无斜杠 glob 递归匹配 basename，结果按 traversal 稳定排序且不读取正文", async () => {
		await mkdir(path.join(testContext.workspace, "src", "deep"), { recursive: true });
		await mkdir(path.join(testContext.workspace, "docs"), { recursive: true });
		await writeFile(path.join(testContext.workspace, "src", "a.ts"), "a");
		await writeFile(path.join(testContext.workspace, "src", "deep", "b.ts"), "b");
		await writeFile(path.join(testContext.workspace, "docs", "c.ts"), "c");
		await writeFile(path.join(testContext.workspace, "src", "deep", "skip.js"), "skip");
		let contentReads = 0;
		const result = expectInventorySuccess(await inventoryWorkspace(testContext.workspace, { paths: ["."], glob: "*.ts" }, 100, (filesystem) => ({
			...filesystem,
			content: {
				readBytes: async (...args) => { contentReads += 1; return await filesystem.content.readBytes(...args); },
				readText: async (...args) => { contentReads += 1; return await filesystem.content.readText(...args); },
				decodeText: filesystem.content.decodeText.bind(filesystem.content),
				sliceText: (...args) => { contentReads += 1; return filesystem.content.sliceText(...args); },
				scanLines: async (...args) => { contentReads += 1; return await filesystem.content.scanLines(...args); },
			},
		})));

		expect(result.files.map((file) => file.path)).toEqual(["docs/c.ts", "src/a.ts", "src/deep/b.ts"]);
		expect(result.files.map((file) => file.scopeRelativePath)).toEqual(["docs/c.ts", "src/a.ts", "src/deep/b.ts"]);
		expect(contentReads).toBe(0);
		expect(result.truncationReasons).toEqual([]);
	});

	it("带斜杠 glob 相对 scope 匹配并从静态目录前缀开始 traversal", async () => {
		await mkdir(path.join(testContext.workspace, "src", "deep"), { recursive: true });
		await mkdir(path.join(testContext.workspace, "other"), { recursive: true });
		await writeFile(path.join(testContext.workspace, "src", "a.ts"), "a");
		await writeFile(path.join(testContext.workspace, "src", "deep", "b.ts"), "b");
		await writeFile(path.join(testContext.workspace, "other", "c.ts"), "c");
		const starts: string[] = [];
		const result = expectInventorySuccess(await inventoryWorkspace(testContext.workspace, { paths: ["."], glob: "src/**/*.ts" }, 100, (filesystem) => ({
			...filesystem,
			traversal: {
				async walk(root, options, context) {
					starts.push(root.displayPath);
					return await filesystem.traversal.walk(root, options, context);
				},
			},
		})));

		expect(starts).toEqual(["src"]);
		expect(result.files.map((file) => file.path)).toEqual(["src/a.ts", "src/deep/b.ts"]);
	});

	it("不存在的静态前缀表示 scope 内零匹配，不产生 scope error", async () => {
		await writeFile(path.join(testContext.workspace, "a.ts"), "a");
		let traversals = 0;
		const result = expectInventorySuccess(await inventoryWorkspace(testContext.workspace, { paths: ["."], glob: "missing/**/*.ts" }, 100, (filesystem) => ({
			...filesystem,
			traversal: {
				async walk(root, options, context) {
					traversals += 1;
					return await filesystem.traversal.walk(root, options, context);
				},
			},
		})));
		expect(result.files).toEqual([]);
		expect(result.scopeErrors).toEqual([]);
		expect(result.traversedEntries).toBe(0);
		expect(traversals).toBe(0);
	});

	it("文件 scope 仅以 basename 判断 glob，且 glob 不扩大 scope", async () => {
		await mkdir(path.join(testContext.workspace, "src"), { recursive: true });
		await writeFile(path.join(testContext.workspace, "src", "a.ts"), "a");
		expect(expectInventorySuccess(await inventoryWorkspace(testContext.workspace, { paths: ["src/a.ts"], glob: "*.ts" })).files)
			.toEqual([expect.objectContaining({ path: "src/a.ts", scopeRelativePath: "a.ts", explicitFile: true })]);
		expect(expectInventorySuccess(await inventoryWorkspace(testContext.workspace, { paths: ["src/a.ts"], glob: "src/*.ts" })).files).toEqual([]);
	});

	it("显式 symlink 文件 scope 可跟随最终目标，自动 traversal 不跟随且 canonical identity 去重", async () => {
		await writeFile(path.join(testContext.workspace, "real.ts"), "real");
		await symlink("real.ts", path.join(testContext.workspace, "alias.ts"));
		const explicit = expectInventorySuccess(await inventoryWorkspace(testContext.workspace, { paths: ["alias.ts", "real.ts"] }));
		expect(explicit.files.map((file) => file.path)).toEqual(["alias.ts"]);
		const discovered = expectInventorySuccess(await inventoryWorkspace(testContext.workspace, { paths: ["."] }));
		expect(discovered.files.map((file) => file.path)).toEqual(["real.ts"]);
	});

	it("glob 前缀剪枝保留显式 ignored root 的 visibility bypass", async () => {
		const configPath = path.join(testContext.outside, "ignored-prefix-inventory.jsonc");
		await writeFile(configPath, JSON.stringify({
			blocked_path: [".git/"],
			ignored_path: ["ignored/"],
			ignore: { builtin_profile: "none", gitignore: false },
		}));
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		await mkdir(path.join(testContext.workspace, "ignored", "deep"), { recursive: true });
		await writeFile(path.join(testContext.workspace, "ignored", "deep", "explicit.ts"), "ignored");
		const result = expectInventorySuccess(await inventoryWorkspace(testContext.workspace, { paths: ["ignored"], glob: "deep/*.ts" }));
		expect(result.files).toEqual([expect.objectContaining({ path: "ignored/deep/explicit.ts", visibilityBypass: true })]);
	});

	it("逐 scope 发现后按 canonical identity 去重，显式 ignored 子 scope 可补回文件", async () => {
		const configPath = path.join(testContext.outside, "ignored-inventory.jsonc");
		await writeFile(configPath, JSON.stringify({
			blocked_path: [".git/"],
			ignored_path: ["ignored/"],
			ignore: { builtin_profile: "none", gitignore: false },
		}));
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		await mkdir(path.join(testContext.workspace, "src"), { recursive: true });
		await mkdir(path.join(testContext.workspace, "ignored"), { recursive: true });
		await writeFile(path.join(testContext.workspace, "src", "visible.ts"), "visible");
		await writeFile(path.join(testContext.workspace, "ignored", "explicit.ts"), "ignored");

		const result = expectInventorySuccess(await inventoryWorkspace(testContext.workspace, { paths: [".", "src", "ignored"] }));
		expect(result.files.map((file) => file.path)).toEqual(["src/visible.ts", "ignored/explicit.ts"]);
		expect(result.files[0]).toMatchObject({ scopeOrder: 0, visibilityBypass: false });
		expect(result.files[1]).toMatchObject({ scopeOrder: 2, visibilityBypass: true });
		expect(new Set(result.files.map((file) => file.canonicalIdentity)).size).toBe(result.files.length);
	});

	it("每个 scope 按原始根目录深度限制范围，glob 前缀不重置深度", async () => {
		await mkdir(path.join(testContext.workspace, "src", "nested", "deep"), { recursive: true });
		await writeFile(path.join(testContext.workspace, "root.ts"), "root");
		await writeFile(path.join(testContext.workspace, "src", "one.ts"), "one");
		await writeFile(path.join(testContext.workspace, "src", "nested", "two.ts"), "two");
		await writeFile(path.join(testContext.workspace, "src", "nested", "deep", "three.ts"), "three");
		const limited = expectInventorySuccess(await inventoryWorkspace(testContext.workspace, { paths: ["."], glob: "src/**/*.ts" }, 2));
		expect(limited.files.map((file) => file.path)).toEqual(["src/one.ts"]);
		expect(limited.truncationReasons).toEqual(["traversal_limit"]);
		const nestedScope = expectInventorySuccess(await inventoryWorkspace(testContext.workspace, { paths: ["src"] }, 2));
		expect(nestedScope.files.map((file) => file.path)).toEqual(["src/nested/two.ts", "src/one.ts"]);
		expect(nestedScope.truncationReasons).toEqual(["traversal_limit"]);
	});

	it("保留 scope union 的成功结果和 blocked/missing 部分错误", async () => {
		await mkdir(path.join(testContext.workspace, ".git"), { recursive: true });
		await mkdir(path.join(testContext.workspace, "src"), { recursive: true });
		await writeFile(path.join(testContext.workspace, ".git", "secret.ts"), "secret");
		await writeFile(path.join(testContext.workspace, "src", "ok.ts"), "ok");
		const result = expectInventorySuccess(await inventoryWorkspace(testContext.workspace, { paths: [".git", "missing", "src"] }));
		expect(result.files.map((file) => file.path)).toEqual(["src/ok.ts"]);
		expect(result.scopeErrors.map((error) => [error.path, error.error.code])).toEqual([
			[".git", "PROTECTED_PATH"],
			["missing", "PATH_NOT_FOUND"],
		]);
		const failed = await inventoryWorkspace(testContext.workspace, { paths: [".git", "missing"] });
		expect(failed).toMatchObject({
			status: "failed",
			error: { code: "PROTECTED_PATH", details: { scope_errors: expect.arrayContaining([
				expect.objectContaining({ path: ".git" }),
				expect.objectContaining({ path: "missing" }),
			]) } },
		});
	});

	it("相同 visibility snapshot 的重复 inventory 文件集合和顺序一致", async () => {
		await mkdir(path.join(testContext.workspace, "src"), { recursive: true });
		await writeFile(path.join(testContext.workspace, "src", "b.ts"), "b");
		await writeFile(path.join(testContext.workspace, "src", "a.ts"), "a");
		const host = new FileToolsHost();
		const opened = await host.open({ cwd: testContext.workspace, sessionId: "grep-inventory-stability" });
		if (isFailed(opened)) throw new Error(opened.error.message);
		try {
			const input = { paths: [".", "src"], glob: "*.ts" } as const;
			const context = { filesystem: opened.filesystem, operation: opened.context, maxDepth: 12 };
			const first = expectInventorySuccess(await buildScopeInventory(input, context));
			const second = expectInventorySuccess(await buildScopeInventory(input, context));
			const snapshot = (inventory: ScopeInventory) => inventory.files.map((file) => ({
				path: file.path,
				identity: file.canonicalIdentity,
				scopeOrder: file.scopeOrder,
				relative: file.scopeRelativePath,
				version: file.metadataVersion,
			}));
			expect(snapshot(second)).toEqual(snapshot(first));
		} finally {
			opened.dispose();
			host.dispose();
		}
	});
});
