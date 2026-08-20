import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { Discovery, DiscoveryEvent } from "../../src/filesystem/contracts/discovery.js";
import { toFileSnapshot } from "../../src/filesystem/contracts/metadata.js";
import { fsSuccess } from "../../src/filesystem/contracts/result.js";
import { buildScopeInventory, type ScopeInventory } from "../../src/file-tools/grep/inventory.js";
import { FileToolsHost } from "../../src/file-tools/runtime/host.js";
import { isFailed } from "../../src/file-tools/shared/result.js";
import { createGrepTestContext, expectInventorySuccess, inventoryWorkspace } from "./grep-fixtures.js";

const testContext = createGrepTestContext();

describe("grep ScopeInventory", () => {
	it("文件和目录 scope 统一委托 discovery，保持输入顺序且不读取正文", async () => {
		await mkdir(path.join(testContext.workspace, "src"), { recursive: true });
		await writeFile(path.join(testContext.workspace, "root.ts"), "root");
		await writeFile(path.join(testContext.workspace, "src", "child.ts"), "child");
		const calls: Array<{ readonly root: string; readonly options: unknown }> = [];
		let contentReads = 0;
		const result = expectInventorySuccess(await inventoryWorkspace(
			testContext.workspace,
			{ paths: ["root.ts", "src"], glob: "*.ts" },
			7,
			(filesystem) => ({
				...filesystem,
				discovery: {
					async discover(root, options, context) {
						calls.push({ root: root.displayPath, options });
						return await filesystem.discovery.discover(root, options, context);
					},
					discoverPaths: (...args) => filesystem.discovery.discoverPaths(...args),
				},
				content: {
					readBytes: async (...args) => { contentReads += 1; return await filesystem.content.readBytes(...args); },
					readText: async (...args) => { contentReads += 1; return await filesystem.content.readText(...args); },
					decodeText: filesystem.content.decodeText.bind(filesystem.content),
					sliceText: (...args) => { contentReads += 1; return filesystem.content.sliceText(...args); },
					scanLines: async (...args) => { contentReads += 1; return await filesystem.content.scanLines(...args); },
				},
			}),
		));

		expect(calls).toEqual([
			{ root: "root.ts", options: { intent: "search", explicitRoot: true, maxDepth: 7, maxEntries: 100_000, glob: "*.ts" } },
			{ root: "src", options: { intent: "search", explicitRoot: true, maxDepth: 7, maxEntries: 100_000, glob: "*.ts" } },
		]);
		expect(result.files).toEqual([
			expect.objectContaining({ path: "root.ts", scopeOrder: 0, scopeRelativePath: "root.ts", explicitFile: true }),
			expect.objectContaining({ path: "src/child.ts", scopeOrder: 1, scopeRelativePath: "child.ts", explicitFile: false }),
		]);
		expect(contentReads).toBe(0);
	});

	it("按 snapshot identity 聚合 memberships，显式 ignored 子 scope 不被父 scope 吞掉", async () => {
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
		expect(result.files[0]).toMatchObject({
			scopeOrder: 0,
			visibilityBypass: false,
			memberships: [
				expect.objectContaining({ scopeOrder: 0, scopeRelativePath: "src/visible.ts" }),
				expect.objectContaining({ scopeOrder: 1, scopeRelativePath: "visible.ts" }),
			],
		});
		expect(result.files[1]).toMatchObject({
			scopeOrder: 2,
			visibilityBypass: true,
			memberships: [expect.objectContaining({ scopeOrder: 2, visibilityBypass: true })],
		});
		expect(new Set(result.files.map((file) => file.snapshot.identity)).size).toBe(result.files.length);
	});

	it("保留 scope union 的成功结果和 blocked/missing 部分错误，全失败返回首个错误及完整明细", async () => {
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

	it("将 discovery skip/error 映射为 traversal truncation、skipped 统计并始终关闭 stream", async () => {
		await writeFile(path.join(testContext.workspace, "event.ts"), "event");
		let closes = 0;
		const result = expectInventorySuccess(await inventoryWorkspace(testContext.workspace, { paths: ["."] }, 12, (filesystem) => ({
			...filesystem,
			discovery: {
				async discover(root, _options, context) {
					const resolved = await filesystem.paths.resolveExisting("event.ts", { expected: "file", followFinalSymlink: true }, context);
					if (!resolved.ok) return resolved;
					if (resolved.value.kind !== "file") throw new Error("expected file fixture");
					const metadata = await filesystem.metadata.stat(resolved.value, context);
					if (!metadata.ok) return metadata;
					const snapshot = toFileSnapshot(metadata.value);
					const events: readonly DiscoveryEvent[] = [
						{ type: "entry", ref: resolved.value, relativePath: "event.ts", depth: 1, snapshot, visibility: { ignored: false, prune: false } },
						{ type: "entry", ref: root, relativePath: "directory", depth: 1, snapshot, visibility: { ignored: false, prune: false } },
						{ type: "skip", path: "ignored.ts", reason: "ignored", kind: "file" },
						{ type: "skip", path: "blocked.ts", reason: "blocked", kind: "file" },
						{ type: "skip", path: "deep", reason: "depth-limit", kind: "directory" },
						{ type: "skip", path: "many", reason: "entry-limit", kind: "directory" },
						{ type: "error", path: "denied.ts", error: { code: "access-denied", message: "denied" }, kind: "file" },
						{ type: "error", path: "changed.ts", error: { code: "not-found", message: "gone" }, kind: "file" },
						{ type: "error", path: "directory", error: { code: "access-denied", message: "denied" } },
					];
					const stream: Discovery = {
						async *[Symbol.asyncIterator]() { yield* events; },
						async close() { closes += 1; },
					};
					return fsSuccess(stream);
				},
				discoverPaths: (...args) => filesystem.discovery.discoverPaths(...args),
			},
		})));

		expect(result.files.map((file) => file.path)).toEqual(["event.ts"]);
		expect(result.traversedEntries).toBe(5);
		expect(result.skipped).toEqual({ access_denied: 2, changed: 1 });
		expect(result.truncationReasons).toEqual(["depth_limit", "entry_limit"]);
		expect(closes).toBe(1);
	});

	it("多个 scope 共享 entry budget，达到边界后停止后续发现", async () => {
		await mkdir(path.join(testContext.workspace, "first"), { recursive: true });
		await mkdir(path.join(testContext.workspace, "second"), { recursive: true });
		await writeFile(path.join(testContext.workspace, "first", "a.ts"), "a");
		await writeFile(path.join(testContext.workspace, "second", "b.ts"), "b");
		await writeFile(path.join(testContext.workspace, "second", "c.ts"), "c");

		const host = new FileToolsHost();
		const opened = await host.open({ cwd: testContext.workspace, sessionId: "grep-inventory-entry-limit" });
		if (isFailed(opened)) throw new Error(opened.error.message);
		try {
			const result = expectInventorySuccess(await buildScopeInventory({ paths: ["first", "second"] }, {
				filesystem: opened.filesystem,
				operation: opened.context,
				maxDepth: 12,
				maxEntries: 2,
			}));
			expect(result.files.map((file) => file.path)).toEqual(["first/a.ts", "second/b.ts"]);
			expect(result.traversedEntries).toBe(2);
			expect(result.truncationReasons).toEqual(["entry_limit"]);
		} finally {
			opened.dispose();
			host.dispose();
		}
	});

	it("相同 visibility snapshot 的重复多 scope inventory 保持文件顺序、membership 和版本稳定", async () => {
		await mkdir(path.join(testContext.workspace, "src"), { recursive: true });
		await writeFile(path.join(testContext.workspace, "src", "b.ts"), "b");
		await writeFile(path.join(testContext.workspace, "src", "a.ts"), "a");
		const host = new FileToolsHost();
		const opened = await host.open({ cwd: testContext.workspace, sessionId: "grep-inventory-stability" });
		if (isFailed(opened)) throw new Error(opened.error.message);
		try {
			const input = { paths: [".", "src"], glob: "*.ts" } as const;
			const context = { filesystem: opened.filesystem, operation: opened.context, maxDepth: 12, maxEntries: 100_000 };
			const first = expectInventorySuccess(await buildScopeInventory(input, context));
			const second = expectInventorySuccess(await buildScopeInventory(input, context));
			const snapshot = (inventory: ScopeInventory) => inventory.files.map((file) => ({
				path: file.path,
				identity: file.snapshot.identity,
				memberships: file.memberships.map((membership) => [membership.scopeOrder, membership.scopeRelativePath]),
				version: file.snapshot.version,
			}));
			expect(snapshot(second)).toEqual(snapshot(first));
		} finally {
			opened.dispose();
			host.dispose();
		}
	});
});
