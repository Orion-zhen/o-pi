import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isReadSuccess } from "../../src/file-tools/read/guards.js";
import { formatReadModelResult, formatReadTextContent } from "../../src/file-tools/read/presenter.js";
import { createCrudTestContext } from "./crud-fixtures.js";
import { expectFailure } from "./result-fixtures.js";

const context = createCrudTestContext();
const source = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n";

describe("read 多范围", () => {
	it("排序并合并相邻、重复和重叠区间，逐段保留原始坐标", async () => {
		await writeFile(path.join(context.workspace, "ranges.txt"), source);
		const result = await context.read({ path: "ranges.txt", lines: "7-99,2-3,1-2,7" });
		expect(result).toMatchObject({
			segments: [
				{ start_line: 1, end_line: 3, content: "one\ntwo\nthree\n" },
				{ start_line: 7, end_line: 8, content: "seven\neight\n" },
			],
			truncated: false,
		});
		if (!isReadSuccess(result)) throw new Error("read failed");
		const output = formatReadModelResult(result);
		expect(output).toContain('lines="1-3,7-8/8"');
		expect(output).toContain('<lines range="7-8">\nseven\neight\n</lines>');
		expect(output).not.toContain("four");
		expect(output.match(/seven/gu)).toHaveLength(1);
	});

	it("跨片段共享行预算，继续范围保留未读区间和空隙", async () => {
		await context.useConfig({ limits: { read_lines: 2 } });
		await writeFile(path.join(context.workspace, "ranges.txt"), source);
		const first = await context.read({ path: "ranges.txt", lines: "1,3-4,6-" });
		expect(first).toMatchObject({
			segments: [{ start_line: 1, end_line: 1 }, { start_line: 3, end_line: 3 }],
			continuation: { lines: "4,6-8" },
		});
		const second = await context.read({ path: "ranges.txt", lines: "4,6-8" });
		expect(second).toMatchObject({
			segments: [{ content: "four\n" }, { content: "six\n" }],
			continuation: { lines: "7-8" },
		});
	});

	it("下一片段的整行无法放入剩余字节预算时保留已有正文", async () => {
		await context.useConfig({ limits: { read_bytes: 1024 } });
		await writeFile(path.join(context.workspace, "bytes.txt"), `${"a".repeat(600)}\nskip\n${"b".repeat(600)}\n`);
		const result = await context.read({ path: "bytes.txt", lines: "1,3" });
		expect(result).toMatchObject({ segments: [{ start_line: 1, end_line: 1 }], continuation: { lines: "3" } });
		if (!isReadSuccess(result)) throw new Error("read failed");
		expect(Buffer.byteLength(formatReadTextContent(result))).toBeLessThanOrEqual(1024);
		const next = await context.read({ path: "bytes.txt", lines: "3" });
		expect(next).toMatchObject({ segments: [{ content: `${"b".repeat(600)}\n` }], truncated: false });
	});

	it("每个片段复用同一快照，结构增强期间的外部写入不混入正文", async () => {
		const file = path.join(context.workspace, "snapshot.ts");
		await writeFile(file, source);
		const ranges: number[] = [];
		const result = await context.read({ path: "snapshot.ts", lines: "1,7" }, {
			structure: {
				async context(input) {
					ranges.push(input.startLine);
					expect(input.content).toBe(source);
					await writeFile(file, "external\n");
					return undefined;
				},
			},
		});
		expect(ranges).toEqual([1, 7]);
		expect(result).toMatchObject({ segments: [{ content: "one\n" }, { content: "seven\n" }] });
		expect(await readFile(file, "utf8")).toBe("external\n");
		expectFailure(await context.edit({ path: "snapshot.ts", edits: [{ old: "external", new: "overwrite" }] }), "STALE_READ");
	});

	it("各片段的结构提示共享整次调用的预算并附着于正确片段", async () => {
		await context.useConfig({ limits: { read_lines: 4 } });
		await writeFile(path.join(context.workspace, "structure.ts"), "function first() {\nwork();\n}\n\n\nfunction second() {\nwork();\n}\n");
		const result = await context.read({ path: "structure.ts", lines: "2,7-8" }, {
			structure: { async context(input) {
				return { enclosing_symbol: input.startLine === 2
					? { name: "first", kind: "function", line: 1, end_line: 3 }
					: { name: "second", kind: "function", line: 6, end_line: 8 } };
			} },
		});
		expect(result).toMatchObject({
			segments: [
				{ start_line: 2, end_line: 2, lsp: { enclosing_symbol: { name: "first" } } },
				{ start_line: 7, end_line: 7, lsp: { enclosing_symbol: { name: "second" } } },
			],
			continuation: { lines: "8" },
		});
	});

	it("分段保留 BOM 元数据和原始换行符", async () => {
		await writeFile(path.join(context.workspace, "unicode.txt"), "\ufeff甲\r\n跳过\r\n乙😀\r丙");
		expect(await context.read({ path: "unicode.txt", lines: "1,3-" })).toMatchObject({
			bom: true,
			segments: [{ content: "甲\r\n" }, { content: "乙😀\r丙" }],
		});
	});

	it("先校验所有区间，非法后续范围不会因预算截断而被忽略", async () => {
		await context.useConfig({ limits: { read_lines: 1 } });
		await writeFile(path.join(context.workspace, "ranges.txt"), source);
		for (const lines of ["1,9", "1-,9", "1,4-3", "1,9007199254740992"]) {
			expectFailure(await context.read({ path: "ranges.txt", lines }), "INVALID_PATH");
		}
	});

	it("片段间取消不返回部分成功", async () => {
		await writeFile(path.join(context.workspace, "cancel.ts"), source);
		const controller = new AbortController();
		let calls = 0;
		const result = await context.read({ path: "cancel.ts", lines: "1,7" }, {
			signal: controller.signal,
			structure: { async context() { calls += 1; controller.abort(); return undefined; } },
		});
		expectFailure(result, "OPERATION_ABORTED");
		expect(calls).toBe(1);
	});
});
