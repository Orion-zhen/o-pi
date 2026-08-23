import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { contentHash as sha256Version } from "../../src/filesystem/services/text.js";
import { isPlainRecord } from "../../src/file-tools/pi/guards.js";
import { createCrudTestContext } from "./crud-fixtures.js";
import { expectFailure } from "./result-fixtures.js";

const testContext = createCrudTestContext();
let workspace: string;

beforeEach(() => {
	workspace = testContext.workspace;
});

describe("edit", () => {
	it("要求目标文件存在且必须先 read", async () => {
		expectFailure(await testContext.edit({ path: "missing.txt", edits: [{ old: "old", new: "new" }] }), "FILE_NOT_FOUND");
		await writeFile(path.join(workspace, "a.txt"), "old\n");
		expectFailure(await testContext.edit({ path: "a.txt", edits: [{ old: "old", new: "new" }] }), {
			code: "READ_REQUIRED", path: "a.txt", next: "Read the file, then create a new edit operation.",
		});
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("old\n");
	});

	it("拒绝超过 edit 单文件上限的 snapshot 和提交内容，且不修改目标", async () => {
		await testContext.useConfig({ limits: { read_max_file_bytes: 2048, edit_max_file_bytes: 1024 } });
		const oversized = path.join(workspace, "edit-large.txt");
		const oversizedText = `old${"x".repeat(1022)}`;
		await writeFile(oversized, oversizedText);
		await testContext.read({ path: "edit-large.txt" });
		expectFailure(await testContext.edit({
			path: "edit-large.txt", edits: [{ old: "old", new: "new" }],
		}), { code: "OUTPUT_LIMIT_EXCEEDED", details: { limit: 1024, size: 1025 } });
		expect(await readFile(oversized, "utf8")).toBe(oversizedText);

		const growing = path.join(workspace, "edit-growing.txt");
		await writeFile(growing, "old");
		await testContext.read({ path: "edit-growing.txt" });
		expectFailure(await testContext.edit({
			path: "edit-growing.txt", edits: [{ old: "old", new: "z".repeat(1025) }],
		}), { code: "OUTPUT_LIMIT_EXCEEDED", details: { limit: 1024, size: 1025 } });
		expect(await readFile(growing, "utf8")).toBe("old");

		const exact = path.join(workspace, "edit-exact.txt");
		await writeFile(exact, "old");
		await testContext.read({ path: "edit-exact.txt" });
		expect(await testContext.edit({
			path: "edit-exact.txt",
			edits: [{ old: "old", new: "q".repeat(1024) }],
		})).toMatchObject({ status: "applied", new_size_bytes: 1024 });
		expect(await readFile(exact, "utf8")).toBe("q".repeat(1024));
	});

	it("一次调用可对同一文件做多个非重叠替换", async () => {
		await writeFile(path.join(workspace, "a.txt"), "one\ntwo\nthree\nfour\n");
		const before = await testContext.read({ path: "a.txt" });
		if (!("version" in before)) throw new Error("read failed");

		const result = await testContext.edit({
			path: "a.txt",
			edits: [
				{ old: "two", new: "TWO" },
				{ old: "four", new: "FOUR" },
			],
		});

		expect(result).toMatchObject({
			status: "applied",
			path: "a.txt",
			replacements: 2,
			old_version: before.version,
			old_size_bytes: Buffer.byteLength("one\ntwo\nthree\nfour\n"),
			new_size_bytes: Buffer.byteLength("one\nTWO\nthree\nFOUR\n"),
		});
		if (!("error" in result)) expect(result.new_version).toBe(sha256Version(Buffer.from("one\nTWO\nthree\nFOUR\n")));
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("one\nTWO\nthree\nFOUR\n");
		if (!("error" in result)) {
			expect(result.diff).toContain("-2 two");
			expect(result.diff).toContain("+2 TWO");
			expect(result.firstChangedLine).toBe(2);
		}
	});

	it("replace_all 替换所有匹配并按实际匹配数计数", async () => {
		await writeFile(path.join(workspace, "a.txt"), "same\nsame\nunique\n");
		const before = await testContext.read({ path: "a.txt" });
		if (!("version" in before)) throw new Error("read failed");
		const params = {
			path: "a.txt",
			edits: [
				{ old: "same", new: "changed", replace_all: true },
				{ old: "unique", new: "single" },
			],
		};

		const preview = await testContext.preview(params);
		expect(preview).toMatchObject({ status: "preview", replacements: 3 });

		const result = await testContext.edit(params);
		expect(result).toMatchObject({ status: "applied", replacements: 3 });
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("changed\nchanged\nsingle\n");
	});

	it("大量 replace_all 命中时线性计算并合并 changed ranges", async () => {
		const matches = 5_000;
		await writeFile(path.join(workspace, "many.txt"), "old\n".repeat(matches));
		await testContext.read({ path: "many.txt" });
		let changedRanges: readonly { startLine: number; endLine: number }[] | undefined;

		const result = await testContext.edit(
			{ path: "many.txt", edits: [{ old: "old", new: "new", replace_all: true }] },
			{
				diff: { generate: () => ({ diff: "" }) },
				diagnostics: {
					async beforeMutation() { return undefined; },
					async afterMutation(input) {
						changedRanges = input.changedRanges;
						return undefined;
					},
				},
			},
		);

		expect(result).toMatchObject({ status: "applied", replacements: matches });
		expect(changedRanges).toEqual([{ startLine: 1, endLine: matches }]);
		expect(await readFile(path.join(workspace, "many.txt"), "utf8")).toBe("new\n".repeat(matches));
	});

	it("并发 edit 同一文件时串行读取和写入，不丢失修改", async () => {
		await writeFile(path.join(workspace, "a.txt"), "alpha beta\n");
		const before = await testContext.read({ path: "a.txt" });
		if (!("version" in before)) throw new Error("read failed");

		const [alpha, beta] = await Promise.all([
			testContext.edit({ path: "a.txt", edits: [{ old: "alpha", new: "ALPHA" }] }),
			testContext.edit({ path: "a.txt", edits: [{ old: "beta", new: "BETA" }] }),
		]);

		expect(alpha).toMatchObject({ status: "applied", path: "a.txt" });
		expect(beta).toMatchObject({ status: "applied", path: "a.txt" });
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("ALPHA BETA\n");
	});

	it("所有 old 都针对原始文件匹配，并诊断依赖前序 replacement 的 old", async () => {
		await writeFile(path.join(workspace, "a.txt"), "a b c\n");
		const before = await testContext.read({ path: "a.txt" });
		if (!("version" in before)) throw new Error("read failed");

		expect(
			await testContext.edit({
				path: "a.txt",
				edits: [
					{ old: "a", new: "x" },
					{ old: "x", new: "y" },
				],
			}),
		).toMatchObject({
			status: "failed",
			error: {
				code: "OLD_TEXT_NOT_FOUND",
				edit_index: 1,
				message: "edits[1].old is absent from the original file, but appears after edits[0].",
				next: "Rewrite edits[1] against the original content, or merge the dependent changes into one replacement.",
				details: { reason: "dependent_edit", after_edit_index: 0 },
			},
		});
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("a b c\n");
	});

	it.each([
		{
			name: "CRLF、缩进、连续空白和行尾空格",
			file: "function run() {\r\n\treturn   value;  \r\n}\r\n",
			old: "function run() {\n  return value;\n}\n",
			candidate: "function run() {\r\n\treturn   value;  \r\n}\r\n",
		},
		{
			name: "old 首部多一行",
			file: "before\ncore();\nafter\n",
			old: "missing context\ncore();\n",
			candidate: "core();\n",
		},
	])("为格式漂移返回唯一原文候选：$name", async ({ file, old, candidate }) => {
		await writeFile(path.join(workspace, "a.txt"), file);
		await testContext.read({ path: "a.txt" });

		const result = await testContext.edit({ path: "a.txt", edits: [{ old, new: "replacement" }] });
		expect(result).toMatchObject({
			status: "failed",
			error: {
				code: "OLD_TEXT_NOT_FOUND",
				message: "edits[0].old was not found exactly; one formatting-equivalent candidate exists.",
				next: "Retry with the shown old text, adapting new if needed; read only if the file changed.",
				details: {
					reason: "format_drift",
					candidates: [{ line: expect.any(Number), old: candidate }],
				},
			},
		});
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe(file);
		if (!("error" in result)) throw new Error("edit unexpectedly succeeded");
		const candidates = result.error.details?.["candidates"];
		const first = Array.isArray(candidates) ? candidates[0] : undefined;
		if (!isPlainRecord(first) || typeof first["old"] !== "string") throw new Error("format candidate missing");
		expect(await testContext.edit({ path: "a.txt", edits: [{ old: first["old"], new: "replacement" }] })).toMatchObject({
			status: "applied",
			replacements: 1,
		});
	});

	it("格式归一化存在多个候选时不把其中一个报告为唯一候选", async () => {
		const source = "first: return value;\nsecond: return   value;\n";
		await writeFile(path.join(workspace, "a.txt"), source);
		await testContext.read({ path: "a.txt" });
		const result = await testContext.edit({
			path: "a.txt",
			edits: [{ old: "return  value;", new: "return next;" }],
		});
		expectFailure(result, "OLD_TEXT_NOT_FOUND");
		if (!("error" in result)) throw new Error("edit unexpectedly succeeded");
		expect(result.error.details?.["reason"]).not.toBe("format_drift");
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe(source);
	});

	it("基于稀有 anchor 返回有限数量的邻近候选", async () => {
		await testContext.useConfig({ limits: { edit_match_hint_limit: 2 } });
		const source = [
			"function first() {",
			"  return commonValue;",
			"}",
			"function targetHandler() {",
			"  return actualValue;",
			"}",
			"function last() {",
			"  return commonValue;",
			"}",
			"",
		].join("\n");
		await writeFile(path.join(workspace, "a.txt"), source);
		await testContext.read({ path: "a.txt" });

		const result = await testContext.edit({
			path: "a.txt",
			edits: [{ old: "function targetHandler() {\n  return expectedValue;\n}", new: "updated" }],
		});
		expect(result).toMatchObject({
			status: "failed",
			error: {
				code: "OLD_TEXT_NOT_FOUND",
				message: "edits[0].old was not found in the original file; 2 nearby candidates shown.",
				next: "Rewrite edits[0].old using a matching candidate, or read the file if none is correct.",
				details: {
					reason: "anchor_candidates",
					shown: 2,
					candidates: expect.arrayContaining([
						{ line: 2, text: expect.stringContaining("targetHandler") },
					]),
				},
			},
		});
		if ("error" in result) expect(result.error.details?.["candidates"]).toHaveLength(2);
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe(source);
	});

	it("重复 old 返回总数、最短唯一 old/new 和起始行号", async () => {
		await writeFile(path.join(workspace, "a.txt"), "const mode = \"dev\";\nconst mode = \"prod\";\nconst mode = \"test\";\n");
		await testContext.read({ path: "a.txt" });

		const result = await testContext.edit({ path: "a.txt", edits: [{ old: "const mode =", new: "let mode =" }] });
		expect(result).toMatchObject({
			status: "failed",
			error: {
				code: "OLD_TEXT_NOT_UNIQUE",
				message: "edits[0].old matched 3 locations.",
				next: "Retry with one shown old/new pair; read only if the file changed.",
				details: { matches: 3, shown: 3, hints: [
					{ line: 1, old: expect.stringContaining("d"), new: expect.stringContaining("let mode") },
					{ line: 2, old: expect.stringContaining("p"), new: expect.stringContaining("let mode") },
					{ line: 3, old: expect.stringContaining("t"), new: expect.stringContaining("let mode") },
				] },
			},
		});
		if (!("error" in result)) throw new Error("edit unexpectedly succeeded");
		const hints = result.error.details?.["hints"];
		if (!Array.isArray(hints) || hints.length === 0) throw new Error("edit hints missing");
		const first = hints[0];
		if (!isPlainRecord(first) || typeof first["old"] !== "string" || typeof first["new"] !== "string") throw new Error("invalid edit hint");
		const retry = await testContext.edit({ path: "a.txt", edits: [{ old: first["old"], new: first["new"] }] });
		expect(retry).toMatchObject({ status: "applied", replacements: 1 });
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("let mode = \"dev\";\nconst mode = \"prod\";\nconst mode = \"test\";\n");
	});

	it("长公共上下文中返回最短唯一提示", async () => {
		const radius = 4_000;
		const old = "TARGET";
		const left = "x".repeat(radius);
		const right = "y".repeat(radius);
		const source = `a${left}${old}${right}|b${left}${old}${right}`;
		await writeFile(path.join(workspace, "a.txt"), source);
		await testContext.read({ path: "a.txt" });

		const result = await testContext.edit({ path: "a.txt", edits: [{ old, new: "NEW" }] });
		expect(result).toMatchObject({
			status: "failed",
			error: {
				code: "OLD_TEXT_NOT_UNIQUE",
				details: {
					hints: [
						{ line: 1, old: `${old}${right}|`, new: `NEW${right}|` },
						{ line: 1, old: `b${left}${old}`, new: `b${left}NEW` },
					],
				},
			},
		});
	});

	it("提示按 Unicode code point 扩展上下文", async () => {
		const source = "😀目标x\n😁目标x\n";
		await writeFile(path.join(workspace, "unicode.txt"), source);
		await testContext.read({ path: "unicode.txt" });
		const result = await testContext.edit({ path: "unicode.txt", edits: [{ old: "目标", new: "替换" }] });
		expect(result).toMatchObject({
			status: "failed",
			error: {
				code: "OLD_TEXT_NOT_UNIQUE",
				details: {
					hints: [
						{ line: 1, old: "😀目标", new: "😀替换" },
						{ line: 2, old: "😁目标", new: "😁替换" },
					],
				},
			},
		});
	});

	it("重叠候选上下文仍能重试对应的 occurrence", async () => {
		await writeFile(path.join(workspace, "overlap.txt"), "aaaa");
		await testContext.read({ path: "overlap.txt" });
		const result = await testContext.edit({ path: "overlap.txt", edits: [{ old: "aa", new: "X" }] });
		expect(result).toMatchObject({
			status: "failed",
			error: {
				code: "OLD_TEXT_NOT_UNIQUE",
				details: {
					hints: [
						{ line: 1, old: "aaa", new: "Xa" },
						{ line: 1, old: "aaaa", new: "aaX" },
					],
				},
			},
		});
		if (!("error" in result)) throw new Error("edit unexpectedly succeeded");
		const hints = result.error.details?.["hints"];
		const second = Array.isArray(hints) ? hints[1] : undefined;
		if (!isPlainRecord(second) || typeof second["old"] !== "string" || typeof second["new"] !== "string") {
			throw new Error("overlap edit hint missing");
		}
		expect(await testContext.edit({ path: "overlap.txt", edits: [{ old: second["old"], new: second["new"] }] })).toMatchObject({
			status: "applied",
			replacements: 1,
		});
		expect(await readFile(path.join(workspace, "overlap.txt"), "utf8")).toBe("aaX");
	});

	it("拒绝不存在、不唯一和重叠的 old", async () => {
		await writeFile(path.join(workspace, "a.txt"), "abc same same xyz\n");
		const before = await testContext.read({ path: "a.txt" });
		if (!("version" in before)) throw new Error("read failed");

		expectFailure(await testContext.edit({ path: "a.txt", edits: [{ old: "missing", new: "new" }] }), { code: "OLD_TEXT_NOT_FOUND", edit_index: 0 });
		expectFailure(await testContext.edit({ path: "a.txt", edits: [{ old: "same", new: "new" }] }), { code: "OLD_TEXT_NOT_UNIQUE", edit_index: 0 });
		expect(
			await testContext.edit({
				path: "a.txt",
				edits: [
					{ old: "abc", new: "ABC" },
					{ old: "bc same", new: "BC SAME" },
				],
			}),
		).toMatchObject({ status: "failed", error: { code: "OVERLAPPING_REPLACEMENTS", edit_index: 1 } });
		expect(
			await testContext.edit({
				path: "a.txt",
				edits: [
					{ old: "same", new: "SAME", replace_all: true },
					{ old: "same xyz", new: "tail" },
				],
			}),
		).toMatchObject({ status: "failed", error: { code: "OVERLAPPING_REPLACEMENTS", edit_index: 1 } });
	});

	it("AbortSignal 在提交前取消 edit 且不修改文件", async () => {
		const file = path.join(workspace, "a.txt");
		await writeFile(file, "old\n");
		await testContext.read({ path: "a.txt" });
		const controller = new AbortController();
		const result = await testContext.edit({ path: "a.txt", edits: [{ old: "old", new: "new" }] }, {
			signal: controller.signal,
			diagnostics: {
				async beforeMutation() {
					controller.abort();
					return undefined;
				},
				async afterMutation() { return undefined; },
			},
		});
		expectFailure(result, "OPERATION_ABORTED");
		expect(await readFile(file, "utf8")).toBe("old\n");
	});

	it("版本冲突不会覆盖外部修改", async () => {
		await writeFile(path.join(workspace, "a.txt"), "old\n");
		const before = await testContext.read({ path: "a.txt" });
		if (!("version" in before)) throw new Error("read failed");
		await writeFile(path.join(workspace, "a.txt"), "external\n");
		const result = await testContext.edit({ path: "a.txt", edits: [{ old: "old", new: "new" }] });
		expect(result).toMatchObject({
			status: "failed",
			error: { code: "STALE_READ", path: "a.txt", next: "Read the file again, then create a new edit operation." },
		});
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("external\n");
	});

	it("保留 UTF-8 BOM、CRLF 和无尾部换行", async () => {
		await writeFile(path.join(workspace, "bom.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("old\n")]));
		await writeFile(path.join(workspace, "crlf.txt"), "a\r\nb\r\n");
		await writeFile(path.join(workspace, "nonewline.txt"), "a\nb");
		const bom = await testContext.read({ path: "bom.txt" });
		const crlf = await testContext.read({ path: "crlf.txt" });
		const nonewline = await testContext.read({ path: "nonewline.txt" });
		if (!("version" in bom) || !("version" in crlf) || !("version" in nonewline)) throw new Error("read failed");

		await testContext.edit({ path: "bom.txt", edits: [{ old: "old", new: "new" }] });
		await testContext.edit({ path: "crlf.txt", edits: [{ old: "a\r\n", new: "A\r\n" }] });
		await testContext.edit({ path: "nonewline.txt", edits: [{ old: "b", new: "B" }] });

		expect(await readFile(path.join(workspace, "bom.txt"))).toEqual(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("new\n")]));
		expect(await readFile(path.join(workspace, "crlf.txt"), "utf8")).toBe("A\r\nb\r\n");
		expect(await readFile(path.join(workspace, "nonewline.txt"), "utf8")).toBe("a\nB");
	});

	it("预览只读生成 diff，执行仍保持 read-before-edit 约束", async () => {
		await writeFile(path.join(workspace, "a.txt"), "old\n");
		const params = { path: "a.txt", edits: [{ old: "old", new: "new" }] };
		const preview = await testContext.preview(params);
		if ("error" in preview) throw new Error(`preview failed: ${preview.error.code}`);
		expect(preview).toMatchObject({ status: "preview", path: "a.txt", replacements: 1, firstChangedLine: 1 });
		expect(preview.diff).toContain("-1 old");
		expect(preview.diff).toContain("+1 new");
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("old\n");

		const result = await testContext.edit(params);
		expectFailure(result, "READ_REQUIRED");
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("old\n");
	});
});
