import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { javascriptAdapter } from "../../src/code-index/adapters/javascript.js";
import { rankingEvidenceSources } from "../../src/file-tools/shared/ranking/evidence.js";
import { loadTreeSitterParser } from "../../src/code-index/tree-sitter-loader.js";
import { parseDocumentForAdapter } from "../../src/code-index/syntax-tree.js";
import type { ContentOperations } from "../../src/filesystem/contracts/content.js";
import type { WorkspaceFileSystem } from "../../src/filesystem/contracts/workspace.js";
import { formatGraphAliasReason, graphNavigationRelation, graphRankingEvidence, isGraphMainCandidate, isGraphNavigationCandidate, type GrepGraphCandidate } from "../../src/file-tools/grep/graph-ranking.js";
import { AbortGrepParse, GrepParser } from "../../src/file-tools/grep/parser-pool.js";
import type { GrepGraphSource } from "../../src/file-tools/grep/ports.js";
import { GrepTool } from "../../src/file-tools/grep/command.js";
import { FileToolsHost } from "../../src/file-tools/runtime/host.js";
import { isFailed } from "../../src/file-tools/shared/result.js";
import type { GrepScopedFile } from "../../src/file-tools/grep/indexer.js";
import { createGrepTestContext, deferredVoid, hydrateGrepSourceText } from "./grep-fixtures.js";

const testContext = createGrepTestContext();

describe("grep lifecycle", () => {
	it("graph ranking 覆盖直接证据、多跳强度、关系意图和 alias 映射", () => {
		const candidate = (overrides: Partial<GrepGraphCandidate> = {}): GrepGraphCandidate => ({
			path: "target.ts",
			confidence: 0.8,
			hop: 0,
			reasons: ["definition"],
			matchedAliases: [],
			relatedEdges: [],
			...overrides,
		});
		const direct = candidate();
		expect(isGraphNavigationCandidate(direct)).toBe(true);
		expect(isGraphNavigationCandidate(candidate({ confidence: 0.4 }))).toBe(false);
		expect(rankingEvidenceSources(graphRankingEvidence(direct, 1))).toEqual(["repo-map-direct"]);
		expect(graphRankingEvidence(candidate({ reasons: ["path similarity"] }), 1).familyCount).toBe(0);
		expect(rankingEvidenceSources(graphRankingEvidence(candidate({ hop: 1, reasons: ["caller"], relatedEdges: [
			{ hop: 1, confidence: 0.9, resolution: "semantic", relatedFiles: [] },
		] }), 2))).toEqual(["repo-map-hop-1"]);
		expect(rankingEvidenceSources(graphRankingEvidence(candidate({ hop: 2, reasons: ["callee"], relatedEdges: [
			{ hop: 1, confidence: 1, resolution: "syntactic", relatedFiles: [] },
			{ hop: 2, confidence: 0.7, resolution: "lexical", relatedFiles: [] },
		] }), 3))).toEqual(["repo-map-hop-2"]);
		expect(graphRankingEvidence(candidate({ hop: 1, reasons: ["reference"], relatedEdges: [
			{ hop: 1, confidence: 0.6, resolution: "syntactic", relatedFiles: [] },
		] }), 4).graph).toBeGreaterThan(0);
		expect(isGraphMainCandidate(direct, "target")).toBe(true);
		expect(isGraphMainCandidate(candidate({ hop: 1, reasons: ["caller"] }), "show callers")).toBe(true);
		expect(isGraphMainCandidate(candidate({ hop: 1, reasons: ["caller"] }), "target")).toBe(false);
		expect(graphNavigationRelation(candidate({ reasons: ["exact symbol"] }))).toBe("symbol");
		expect(graphNavigationRelation(candidate({ reasons: ["unknown"] }))).toBeUndefined();
		const alias = candidate({ reasons: ["alias"], matchedAliases: [{ term: "auth", canonical: "authentication" }] });
		expect(graphNavigationRelation(alias)).toBe("alias auth->authentication");
		expect(formatGraphAliasReason(candidate({ matchedAliases: [] }))).toBe("alias");
		expect(formatGraphAliasReason(candidate({ matchedAliases: [{ term: "Auth", canonical: "auth" }] }))).toBe("alias");
	});

	it("parser owner 支持本地、worker 和幂等 dispose", async () => {
		const parser = new GrepParser();
		const local = await parser.analyzeFile("notes.txt", "needle\n", undefined, false);
		expect(local.status).toBe("unsupported");
		const worker = await parser.analyzeFiles(
			Array.from({ length: 33 }, (_value, index) => ({ path: `module-${index}.ts`, text: `export const value${index} = ${index};\n`, syntax: true })),
			undefined,
		);
		expect(worker).toHaveLength(33);
		const shared = await loadTreeSitterParser(javascriptAdapter);
		if (!("parser" in shared)) throw new Error("javascript parser unavailable");
		parser.dispose();
		parser.dispose();
		const retained = await loadTreeSitterParser(javascriptAdapter);
		if (!("parser" in retained)) throw new Error("javascript parser unavailable after grep disposal");
		expect(retained.parser).toBe(shared.parser);
		const document = await parseDocumentForAdapter(javascriptAdapter, "export const retained = true;\n");
		expect(document.document).toBeDefined();
		document.document?.dispose();
		await expect(parser.analyzeFiles([], undefined)).rejects.toBeInstanceOf(AbortGrepParse);

		const pendingParser = new GrepParser();
		const pending = pendingParser.analyzeFiles(
			Array.from({ length: 64 }, (_value, index) => ({
				path: `pending-${index}.ts`,
				text: `export const pending${index} = '${"x".repeat(16 * 1024)}';\n`,
				syntax: true,
			})),
			undefined,
		);
		pendingParser.dispose();
		await expect(pending).rejects.toBeInstanceOf(AbortGrepParse);
	});

	it("grep owner dispose 幂等且停止后拒绝新调用", async () => {
		const host = new FileToolsHost();
		const tool = new GrepTool();
		const opened = await host.open({ cwd: testContext.workspace, sessionId: "grep-owner" });
		if (isFailed(opened)) throw new Error(opened.error.message);
		try {
			tool.dispose();
			tool.dispose();
			await expect(tool.execute({ query: "needle" }, {
				filesystem: opened.filesystem,
				operation: opened.context,
				limits: opened.limits,
			})).resolves.toMatchObject({ status: "failed", error: { code: "OPERATION_ABORTED" } });
		} finally {
			opened.dispose();
			host.dispose();
		}
	});

	it("grep owner dispose 取消 index 后 graph 阶段的 active execute", async () => {
		await writeFile(path.join(testContext.workspace, "active.ts"), "export const active = true;\n");
		const host = new FileToolsHost();
		const tool = new GrepTool();
		const opened = await host.open({ cwd: testContext.workspace, sessionId: "grep-owner-active" });
		if (isFailed(opened)) throw new Error(opened.error.message);
		const started = deferredVoid();
		let graphAborted = false;
		const graph: GrepGraphSource = {
			async query(input) {
				started.resolve();
				await new Promise<void>((_resolve, reject) => {
					const onAbort = () => {
						graphAborted = true;
						reject(new Error("aborted"));
					};
					if (input.signal?.aborted === true) onAbort();
					else input.signal?.addEventListener("abort", onAbort, { once: true });
				});
				return [];
			},
		};
		try {
			const active = tool.execute({ query: "missingSymbol" }, {
				filesystem: opened.filesystem,
				operation: {},
				limits: opened.limits,
				graph,
			});
			await started.promise;
			tool.dispose();
			await expect(active).resolves.toMatchObject({ status: "failed", error: { code: "OPERATION_ABORTED" } });
			expect(graphAborted).toBe(true);
		} finally {
			tool.dispose();
			opened.dispose();
			host.dispose();
		}
	});

	it("literal 只执行一次稳定 line scan，不完整读取正文", async () => {
		await writeFile(path.join(testContext.workspace, "stream.txt"), `needle\n${"tail\n".repeat(200)}`);
		const host = new FileToolsHost();
		const tool = new GrepTool();
		const opened = await host.open({ cwd: testContext.workspace, sessionId: "grep-stream" });
		if (isFailed(opened)) throw new Error(opened.error.message);
		let fullReads = 0;
		let lineScans = 0;
		const original = opened.filesystem.content;
		const content: ContentOperations = {
			readBytes: original.readBytes.bind(original),
			async readText(file, options, context) {
				fullReads += 1;
				return await original.readText(file, options, context);
			},
			decodeText: original.decodeText.bind(original),
			sliceText: original.sliceText.bind(original),
			async scanLines(file, options, context) {
				lineScans += 1;
				return await original.scanLines(file, options, context);
			},
		};
		const filesystem: WorkspaceFileSystem = { ...opened.filesystem, content };
		try {
			const result = await tool.execute({ path: ["stream.txt"], query: "needle", match: "literal" }, {
				filesystem,
				operation: opened.context,
				limits: opened.limits,
			});
			expect(result).toMatchObject({ status: "success", regions: [expect.objectContaining({ path: "stream.txt" })] });
			expect({ fullReads, lineScans }).toEqual({ fullReads: 0, lineScans: 1 });
		} finally {
			tool.dispose();
			opened.dispose();
			host.dispose();
		}
	});

	it("active strict line scan 响应取消且不继续返回部分命中", async () => {
		await writeFile(path.join(testContext.workspace, "cancel.txt"), `${"line\n".repeat(20_000)}needle\n`);
		const host = new FileToolsHost();
		const tool = new GrepTool();
		const opened = await host.open({ cwd: testContext.workspace, sessionId: "grep-strict-cancel" });
		if (isFailed(opened)) throw new Error(opened.error.message);
		const controller = new AbortController();
		const started = deferredVoid();
		const original = opened.filesystem.content;
		const filesystem: WorkspaceFileSystem = {
			...opened.filesystem,
			content: {
				readBytes: original.readBytes.bind(original),
				readText: original.readText.bind(original),
				decodeText: original.decodeText.bind(original),
				sliceText: original.sliceText.bind(original),
				async scanLines(file, options, context) {
					started.resolve();
					return await original.scanLines(file, options, context);
				},
			},
		};
		try {
			const active = tool.execute({ path: ["cancel.txt"], query: "needle", match: "literal" }, {
				filesystem,
				operation: { signal: controller.signal },
				limits: opened.limits,
			});
			await started.promise;
			controller.abort();
			await expect(active).resolves.toMatchObject({ status: "failed", error: { code: "OPERATION_ABORTED" } });
		} finally {
			tool.dispose();
			opened.dispose();
			host.dispose();
		}
	});

	it("external hydration 对预加载、缺失、stale、size 和取消候选安全降级", async () => {
		await writeFile(path.join(testContext.workspace, "hydrate.txt"), "needle\n");
		const host = new FileToolsHost();
		const opened = await host.open({ cwd: testContext.workspace, sessionId: "grep-hydration" });
		if (isFailed(opened)) throw new Error(opened.error.message);
		try {
			const resolved = await opened.filesystem.paths.resolveExisting("hydrate.txt", { expected: "file", followFinalSymlink: false }, opened.context);
			if (!resolved.ok || resolved.value.kind !== "file") throw new Error("fixture was not resolved");
			const metadata = await opened.filesystem.metadata.stat(resolved.value, opened.context);
			if (!metadata.ok) throw new Error(metadata.error.message);
			const file: GrepScopedFile = {
				path: "hydrate.txt",
				id: resolved.value.id,
				size: metadata.value.sizeBytes,
				metadataVersion: metadata.value.version ?? `${metadata.value.sizeBytes}:${metadata.value.modifiedAtMs}`,
			};
			const context = { filesystem: opened.filesystem, operation: opened.context, maxFileBytes: 1024 };
			const preloaded = new Map([[file.path, "cached"]]);
			expect(await hydrateGrepSourceText(preloaded, new Map(), new Map([[file.path, file]]), [file.path], context)).toBe(preloaded);
			expect(await hydrateGrepSourceText(new Map(), new Map(), new Map(), [file.path], context)).toEqual(new Map());
			const hydrated = await hydrateGrepSourceText(new Map(), new Map(), new Map([[file.path, file]]), [file.path], context);
			expect(hydrated).toEqual(new Map([[file.path, "needle\n"]]));
			expect(await hydrateGrepSourceText(
				new Map(),
				new Map(),
				new Map([["missing.txt", { ...file, path: "missing.txt" }]]),
				["missing.txt"],
				context,
			)).toEqual(new Map());
			expect(await hydrateGrepSourceText(new Map(), new Map(), new Map([[file.path, { ...file, metadataVersion: "stale" }]]), [file.path], context)).toEqual(new Map());
			expect(await hydrateGrepSourceText(new Map(), new Map(), new Map([[file.path, file]]), [file.path], { ...context, maxFileBytes: 1 })).toEqual(new Map());
			const contentFailure = (code: "binary" | "aborted"): ContentOperations => ({
				readBytes: opened.filesystem.content.readBytes.bind(opened.filesystem.content),
				async readText() { return { ok: false, error: { code, message: "injected read failure", path: file.path } }; },
				decodeText: opened.filesystem.content.decodeText.bind(opened.filesystem.content),
				sliceText: opened.filesystem.content.sliceText.bind(opened.filesystem.content),
				scanLines: opened.filesystem.content.scanLines.bind(opened.filesystem.content),
			});
			for (const code of ["binary", "aborted"] as const) {
				const failed = await hydrateGrepSourceText(new Map(), new Map(), new Map([[file.path, file]]), [file.path], {
					...context,
					filesystem: { ...opened.filesystem, content: contentFailure(code) },
				});
				if (code === "aborted") expect(failed).toMatchObject({ status: "failed", error: { code: "OPERATION_ABORTED" } });
				else expect(failed).toEqual(new Map());
			}
			const abortedResult = await hydrateGrepSourceText(new Map(), new Map(), new Map([[file.path, file]]), [file.path], {
				...context,
				operation: { signal: AbortSignal.abort() },
			});
			expect(abortedResult).toMatchObject({ status: "failed", error: { code: "OPERATION_ABORTED" } });
		} finally {
			opened.dispose();
			host.dispose();
		}
	});
});
