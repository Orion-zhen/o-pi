import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { TextContent } from "../../src/filesystem/contracts/content.js";
import {
	buildTextBytes,
	byteRangeForLines,
	describeText,
	extractByteRange,
	logicalLines,
	normalizeLineEndings,
	resolveTextRange,
	sliceTextByLineRange,
	utf8ByteOffset,
} from "../../src/filesystem/services/text.js";
import { useTempDir } from "../helpers/lifecycle.js";
import { expectFsOk, openReadonly, resolveFile } from "./fixtures.js";

const temp = useTempDir("o-pi-readonly-fs-");
let workspace: string;

beforeEach(async () => {
	workspace = path.join(temp.path, "workspace");
	await mkdir(workspace);
});

describe("filesystem text services", () => {
	it("reads bounded UTF-8 content with raw hashes, BOM, CRLF and logical line metadata", async () => {
		const bytes = buildTextBytes("first\r\nsecond\r\n", true);
		await writeFile(path.join(workspace, "text.txt"), bytes);
		const opened = await openReadonly(workspace);
		const file = await resolveFile(opened.namespace, "text.txt");

		const raw = expectFsOk(await opened.services.content.readBytes(file, { maxBytes: bytes.byteLength }));
		expect(raw).toMatchObject({ sizeBytes: bytes.byteLength, hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) });
		expect(raw.bytes).toEqual(bytes);

		const text = expectFsOk(await opened.services.content.readText(file, { maxBytes: bytes.byteLength }));
		expect(text).toMatchObject({ text: "first\r\nsecond\r\n", totalLines: 2, newline: "crlf", hasBom: true });
		expect(expectFsOk(sliceTextByLineRange(text, {
			startLine: 2,
			maxBytes: 100,
			maxLines: 1,
			path: "text.txt",
		}))).toEqual({ content: "second\r\n", startLine: 2, endLine: 2, truncated: false });
	});

	it.each([
		{ text: "", totalLines: 0, newline: "none" },
		{ text: "plain", totalLines: 1, newline: "none" },
		{ text: "\n", totalLines: 1, newline: "lf" },
		{ text: "a\n\n", totalLines: 2, newline: "lf" },
		{ text: "a\r\nb\r\n", totalLines: 2, newline: "crlf" },
		{ text: "a\nb\r\nc", totalLines: 3, newline: "mixed" },
		{ text: "a\rb", totalLines: 2, newline: "mixed" },
		{ text: "\r", totalLines: 1, newline: "mixed" },
	] as const)("describes text with $newline newlines", ({ text, totalLines, newline }) => {
		expect(describeText(new Uint8Array(), text)).toEqual({ totalLines, newline, hasBom: false });
	});

	it("validates decoded-text line, code-unit and UTF-8 byte coordinates", () => {
		const text = "你😀\r\nb\rc\n\n";
		expect([
			utf8ByteOffset(text, 0),
			utf8ByteOffset(text, 1),
			utf8ByteOffset(text, 2),
			utf8ByteOffset(text, 3),
		]).toEqual([0, 3, undefined, 7]);
		expect(utf8ByteOffset(text, -1)).toBeUndefined();
		expect(utf8ByteOffset(text, 1.5)).toBeUndefined();
		expect(utf8ByteOffset(text, text.length + 1)).toBeUndefined();

		expect(byteRangeForLines(text, 2, 3)).toEqual({ startLine: 2, endLine: 3, startByte: 9, endByte: 13 });
		expect(byteRangeForLines(text, 4, 4)).toEqual({ startLine: 4, endLine: 4, startByte: 13, endByte: 14 });
		expect(byteRangeForLines("", 1, 1)).toBeUndefined();
		expect(byteRangeForLines(text, 0, 1)).toBeUndefined();
		expect(byteRangeForLines(text, 3, 2)).toBeUndefined();
		expect(byteRangeForLines(text, 1, 5)).toBeUndefined();

		expect(resolveTextRange(text, { startLine: 1, endLine: 1 })).toEqual({
			startLine: 1, endLine: 1, startByte: 0, endByte: 9,
		});
		expect(resolveTextRange(text, { startLine: 1, endLine: 1, startByte: 3, endByte: 7 })).toEqual({
			startLine: 1, endLine: 1, startByte: 3, endByte: 7,
		});
		expect(resolveTextRange(text, { startLine: 1, endLine: 1, startByte: 4, endByte: 7 })).toBeUndefined();
		expect(resolveTextRange(text, { startLine: 1, endLine: 1, startByte: 3 })).toBeUndefined();
		expect(resolveTextRange(text, { startLine: 2, endLine: 2, startByte: 0, endByte: 1 })).toBeUndefined();
		expect(resolveTextRange(text, { startLine: 1.5, endLine: 2 })).toBeUndefined();

		expect(extractByteRange(text, 3, 7)).toBe("😀");
		expect(extractByteRange(text, 9, 13)).toBe("b\rc\n");
		expect(extractByteRange(text, 4, 7)).toBeUndefined();
		expect(extractByteRange(text, -1, 0)).toBeUndefined();
		expect(extractByteRange(text, 0, 99)).toBeUndefined();
	});

	it("handles empty and mixed-newline text and rejects a single over-budget line", async () => {
		await writeFile(path.join(workspace, "empty.txt"), "");
		await writeFile(path.join(workspace, "mixed.txt"), "one\rtwo\nthree");
		const opened = await openReadonly(workspace);
		const empty = expectFsOk(await opened.readText("empty.txt"));
		expect(empty).toMatchObject({ text: "", totalLines: 0, newline: "none", hasBom: false });
		const mixed = expectFsOk(await opened.readText("mixed.txt"));
		expect(mixed).toMatchObject({ totalLines: 3, newline: "mixed" });
		expect(sliceTextByLineRange(mixed, { maxBytes: 2, maxLines: 10, path: "mixed.txt" })).toMatchObject({
			ok: false,
			error: { code: "too-large" },
		});
		expect(expectFsOk(sliceTextByLineRange(mixed, { maxBytes: 100, maxLines: 1, path: "mixed.txt" }))).toEqual({
			content: "one\r",
			startLine: 1,
			endLine: 1,
			truncated: true,
			continuation: { startLine: 2 },
		});
		expect(sliceTextByLineRange(mixed, { startLine: 4, maxBytes: 10, maxLines: 1, path: "mixed.txt" })).toMatchObject({
			ok: false,
			error: { code: "invalid-path" },
		});
		expect(normalizeLineEndings("a\r\nb\rc")).toBe("a\nb\nc");
		expect(logicalLines("a\n")).toEqual({ lines: ["a"], finalNewline: true });
	});

	it("stops slicing once line or byte budgets are exhausted", () => {
		const text = `head\n${"x".repeat(1_024)}\n${"y\n".repeat(1_000_000)}`;
		const file: TextContent = {
			text,
			totalLines: 1_000_002,
			newline: "lf",
			hasBom: false,
			bytes: new Uint8Array(),
			hash: "unused",
			sizeBytes: 0,
		};
		const expected = {
			content: "head\n",
			startLine: 1,
			endLine: 1,
			truncated: true,
			continuation: { startLine: 2 },
		};

		expect(expectFsOk(sliceTextByLineRange(file, { maxBytes: 5, maxLines: 10, path: "large.txt" }))).toEqual(expected);
		expect(expectFsOk(sliceTextByLineRange(file, { maxBytes: 10_000, maxLines: 1, path: "large.txt" }))).toEqual(expected);
	});

	it("preserves raw terminators and UTF-8 byte budgets while slicing", () => {
		const text = "你\r\nb\rc\nlast";
		const file: TextContent = {
			text,
			totalLines: 4,
			newline: "mixed",
			hasBom: false,
			bytes: new Uint8Array(),
			hash: "unused",
			sizeBytes: 0,
		};

		expect(expectFsOk(sliceTextByLineRange(file, {
			startLine: 2,
			endLine: 3,
			maxBytes: 4,
			maxLines: 10,
			path: "mixed.txt",
		}))).toEqual({ content: "b\rc\n", startLine: 2, endLine: 3, truncated: false });
		expect(expectFsOk(sliceTextByLineRange(file, {
			startLine: 2,
			maxBytes: 3,
			maxLines: 10,
			path: "mixed.txt",
		}))).toEqual({
			content: "b\r",
			startLine: 2,
			endLine: 2,
			truncated: true,
			continuation: { startLine: 3 },
		});
	});

	it.each([
		{ name: "binary.dat", bytes: new Uint8Array([0x61, 0x00, 0x62]), code: "binary" },
		{ name: "invalid.txt", bytes: new Uint8Array([0xc3, 0x28]), code: "invalid-utf8" },
	])("rejects $code content", async ({ name, bytes, code }) => {
		await writeFile(path.join(workspace, name), bytes);
		const opened = await openReadonly(workspace);
		const result = await opened.readText(name);
		expect(result).toMatchObject({ ok: false, error: { code, path: name } });
	});

	it("rejects files over the read limit without returning partial bytes", async () => {
		await writeFile(path.join(workspace, "large.txt"), "12345");
		const opened = await openReadonly(workspace);
		expect(await opened.readBytes("large.txt", { maxBytes: 4 })).toMatchObject({ ok: false, error: { code: "too-large", details: { limit: 4, size: 5 } } });
	});
});
