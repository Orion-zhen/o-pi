import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createFileIdentity } from "../../src/code-index/identity.js";
import {
	indexRepoMapSymbols,
	REPO_MAP_PARSER_BATCH_SIZE,
	shouldOffloadRepoMapParsing,
} from "../../src/repo-map/indexing/symbol-indexer.js";
import { useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-repo-map-workers-");

describe("Repo Map parser workers", () => {
	it("uses local parsing for small workloads and bounded worker batches for large workloads", () => {
		expect(shouldOffloadRepoMapParsing({ fileCount: 2, totalBytes: 200, maxFileBytes: 100 }, { concurrency: 8 })).toBe(false);
		expect(shouldOffloadRepoMapParsing({ fileCount: REPO_MAP_PARSER_BATCH_SIZE * 4, totalBytes: 2_000_000, maxFileBytes: 20_000 }, { concurrency: 8 })).toBe(true);
		expect(shouldOffloadRepoMapParsing({ fileCount: 1, totalBytes: 300_000, maxFileBytes: 300_000 }, { concurrency: 8 })).toBe(true);
	});

	it("returns deterministic symbols and syntax facts from a worker", async () => {
		const source = "export function workerValue(): number { return 1; }\nregisterCommand(\"worker-command\", workerValue);\n";
		const filePath = "src/worker-fixture.ts";
		await mkdir(path.join(temp.path, "src"));
		await writeFile(path.join(temp.path, filePath), source);
		const file = {
			...createFileIdentity(filePath),
			size: 300_000,
			mtimeMs: 1,
			status: "indexed" as const,
			contentHash: createHash("sha256").update(source).digest("hex"),
		};
		const first = await indexRepoMapSymbols({ root: temp.path, files: [file], concurrency: 4 });
		const second = await indexRepoMapSymbols({ root: temp.path, files: [file], concurrency: 4 });

		expect(second.symbols).toEqual(first.symbols);
		expect(second.imports).toEqual(first.imports);
		expect(second.syntaxFactsByFile).toEqual(first.syntaxFactsByFile);
		expect(first.symbols.some((symbol) => symbol.name === "workerValue")).toBe(true);
		const facts = first.syntaxFactsByFile?.get(file.id);
		expect(facts?.registrations.map((registration) => registration.name)).toEqual(["worker-command"]);
	});

	it("preserves recovered worker symbols and reports incomplete syntax facts", async () => {
		const source = "export function recovered() {\n";
		const filePath = "src/recovered.ts";
		await mkdir(path.join(temp.path, "src"), { recursive: true });
		await writeFile(path.join(temp.path, filePath), source);
		const file = {
			...createFileIdentity(filePath),
			size: 300_000,
			mtimeMs: 1,
			status: "indexed" as const,
			contentHash: createHash("sha256").update(source).digest("hex"),
		};

		const result = await indexRepoMapSymbols({ root: temp.path, files: [file], concurrency: 2 });

		expect(result.symbols.some((symbol) => symbol.name === "recovered")).toBe(true);
		expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "PARSER_SYNTAX_ERROR", path: filePath }));
	});

	it("把扫描后增长并超过记录大小的文件报告为 changed", async () => {
		const source = "export const beforeGrowth = true;\n";
		const filePath = "src/grew.ts";
		await mkdir(path.join(temp.path, "src"), { recursive: true });
		await writeFile(path.join(temp.path, filePath), `${source}${"export const added = true;\n".repeat(64)}`);
		const file = {
			...createFileIdentity(filePath),
			size: Buffer.byteLength(source),
			mtimeMs: 1,
			status: "indexed" as const,
			contentHash: createHash("sha256").update(source).digest("hex"),
		};

		const result = await indexRepoMapSymbols({ root: temp.path, files: [file], concurrency: 1 });

		expect(result.symbols).toEqual([]);
		expect(result.diagnostics).toEqual([
			expect.objectContaining({ code: "FILE_CHANGED_DURING_PARSE", path: filePath }),
		]);
	});

	it("falls back locally after worker creation failure", async () => {
		const source = "export const localFallback = true;\n";
		const filePath = "src/fallback.ts";
		await mkdir(path.join(temp.path, "src"), { recursive: true });
		await writeFile(path.join(temp.path, filePath), source);
		const file = {
			...createFileIdentity(filePath),
			size: 300_000,
			mtimeMs: 1,
			status: "indexed" as const,
			contentHash: createHash("sha256").update(source).digest("hex"),
		};
		const result = await indexRepoMapSymbols({
			root: temp.path,
			files: [file],
			concurrency: 2,
			workerFactory: () => { throw new Error("simulated worker failure"); },
		});
		expect(result.diagnostics).toEqual([]);
		expect(result.symbols.some((symbol) => symbol.name === "localFallback")).toBe(true);
	});

	it("does not fall back after cancellation", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(indexRepoMapSymbols({ root: temp.path, files: [], concurrency: 2, signal: controller.signal })).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
	});
});
