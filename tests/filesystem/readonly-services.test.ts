import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { FileRef } from "../../src/filesystem/contracts/path.js";
import type { FsResult } from "../../src/filesystem/contracts/result.js";
import type { VisibilityPolicy } from "../../src/filesystem/contracts/visibility.js";
import { createWorkspaceNamespace, type WorkspaceNamespaceKernel } from "../../src/filesystem/kernel/namespace.js";
import {
	NativeFileSystemError,
	NodeNativeFileSystem,
	type NativeFileSystem,
	type NativeMetadata,
	type NativeOpenFile,
} from "../../src/filesystem/platform/node/native-filesystem.js";
import { pathNameSimilarity } from "../../src/filesystem/services/path-catalog.js";
import { compareLogicalPath } from "../../src/filesystem/services/path-order.js";
import {
	createReadonlyFileSystemServices,
	type ReadonlyFileSystemServices,
} from "../../src/filesystem/services/readonly.js";
import {
	buildTextBytes,
	logicalLines,
	normalizeLineEndings,
	sliceTextByLineRange,
} from "../../src/filesystem/services/text.js";
import { createVisibilityPolicy } from "../../src/filesystem/services/visibility/policy.js";
import { WorkspaceVisibilityService } from "../../src/filesystem/services/visibility/service.js";
import { useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-readonly-fs-");
let workspace: string;

beforeEach(async () => {
	workspace = path.join(temp.path, "workspace");
	await mkdir(workspace);
});

describe("filesystem content and text services", () => {
	it("reads bounded UTF-8 content with raw hashes, BOM, CRLF and logical line metadata", async () => {
		const bytes = buildTextBytes("first\r\nsecond\r\n", true);
		await writeFile(path.join(workspace, "text.txt"), bytes);
		const opened = await openReadonly();
		const file = await resolveFile(opened.namespace, "text.txt");

		const raw = expectOk(await opened.services.content.readBytes(file, { maxBytes: bytes.byteLength, stable: true }, {}));
		expect(raw).toMatchObject({ sizeBytes: bytes.byteLength, hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) });
		expect(raw.bytes).toEqual(bytes);

		const text = expectOk(await opened.services.content.readText(file, { maxBytes: bytes.byteLength, stable: true }, {}));
		expect(text).toMatchObject({ text: "first\r\nsecond\r\n", totalLines: 2, newline: "crlf", hasBom: true });
		expect(expectOk(sliceTextByLineRange(text, {
			startLine: 2,
			maxBytes: 100,
			maxLines: 1,
			path: "text.txt",
		}))).toEqual({ content: "second\r\n", startLine: 2, endLine: 2, truncated: false });
	});

	it("handles empty and mixed-newline text and rejects a single over-budget line", async () => {
		await writeFile(path.join(workspace, "empty.txt"), "");
		await writeFile(path.join(workspace, "mixed.txt"), "one\rtwo\nthree");
		const opened = await openReadonly();
		const empty = expectOk(await opened.services.content.readText(
			await resolveFile(opened.namespace, "empty.txt"),
			{},
			{},
		));
		expect(empty).toMatchObject({ text: "", totalLines: 0, newline: "none", hasBom: false });
		const mixed = expectOk(await opened.services.content.readText(
			await resolveFile(opened.namespace, "mixed.txt"),
			{},
			{},
		));
		expect(mixed).toMatchObject({ totalLines: 3, newline: "mixed" });
		expect(sliceTextByLineRange(mixed, { maxBytes: 2, maxLines: 10 })).toMatchObject({
			ok: false,
			error: { code: "too-large" },
		});
		expect(expectOk(sliceTextByLineRange(mixed, { maxBytes: 100, maxLines: 1 }))).toEqual({
			content: "one\r",
			startLine: 1,
			endLine: 1,
			truncated: true,
			continuation: { startLine: 2 },
		});
		for (const options of [
			{ startLine: 0, maxBytes: 10, maxLines: 1 },
			{ endLine: 0, maxBytes: 10, maxLines: 1 },
			{ startLine: 2, endLine: 1, maxBytes: 10, maxLines: 1 },
			{ maxBytes: 0, maxLines: 1 },
		]) {
			expect(sliceTextByLineRange(mixed, options)).toMatchObject({ ok: false, error: { code: "invalid-path" } });
		}
		expect(sliceTextByLineRange(mixed, { startLine: 4, maxBytes: 10, maxLines: 1 })).toMatchObject({
			ok: false,
			error: { code: "invalid-path" },
		});
		expect(normalizeLineEndings("a\r\nb\rc")).toBe("a\nb\nc");
		expect(logicalLines("a\n")).toEqual({ lines: ["a"], finalNewline: true });
	});

	it.each([
		{ name: "binary.dat", bytes: new Uint8Array([0x61, 0x00, 0x62]), code: "binary" },
		{ name: "invalid.txt", bytes: new Uint8Array([0xc3, 0x28]), code: "invalid-utf8" },
	])("rejects $code content", async ({ name, bytes, code }) => {
		await writeFile(path.join(workspace, name), bytes);
		const opened = await openReadonly();
		const result = await opened.services.content.readText(await resolveFile(opened.namespace, name), {}, {});
		expect(result).toMatchObject({ ok: false, error: { code, path: name } });
	});

	it("rejects files over the read limit without returning partial bytes", async () => {
		await writeFile(path.join(workspace, "large.txt"), "12345");
		const opened = await openReadonly();
		expect(await opened.services.content.readBytes(
			await resolveFile(opened.namespace, "large.txt"),
			{ maxBytes: 4 },
			{},
		)).toMatchObject({ ok: false, error: { code: "too-large", details: { limit: 4, size: 5 } } });
	});

	it.skipIf(process.platform === "win32")("blocks a protected final symlink introduced immediately before open", async () => {
		const protectedDirectory = path.join(temp.path, "read-race-protected");
		const protectedFile = path.join(protectedDirectory, "secret.txt");
		const racedFile = path.join(workspace, "raced.txt");
		await mkdir(protectedDirectory);
		await writeFile(protectedFile, "secret");
		await writeFile(racedFile, "safe");
		let replaced = false;
		const native = wrapNative(new NodeNativeFileSystem(), {
			async beforeOpen(pathname) {
				if (pathname !== racedFile || replaced) return;
				replaced = true;
				await rm(racedFile);
				await symlink(protectedFile, racedFile);
			},
		});
		const opened = await openReadonly({ native, blockedPaths: [`${protectedDirectory}${path.sep}`] });
		const file = await resolveFile(opened.namespace, "raced.txt");
		expect(await opened.services.content.readBytes(file, {}, {})).toMatchObject({
			ok: false,
			error: { code: "blocked", details: { phase: "canonical" } },
		});
		expect(await new NodeNativeFileSystem().read(protectedFile)).toEqual(Buffer.from("secret"));
	});

	it("detects metadata changes during stable reads", async () => {
		await writeFile(path.join(workspace, "changing.txt"), "content");
		let statCalls = 0;
		const native = wrapNative(new NodeNativeFileSystem(), {
			stat(metadata) {
				statCalls += 1;
				return statCalls > 1 ? { ...metadata, version: `${metadata.version}:changed` } : metadata;
			},
		});
		const opened = await openReadonly({ native });
		expect(await opened.services.content.readBytes(
			await resolveFile(opened.namespace, "changing.txt"),
			{ stable: true },
			{},
		)).toMatchObject({ ok: false, error: { code: "changed-during-read" } });
	});

	it("streams logical lines with exact byte ranges and closes on completion", async () => {
		const bytes = buildTextBytes("alpha\r\nβ\nlast", true);
		await writeFile(path.join(workspace, "lines.txt"), bytes);
		const tracker = { opened: 0, closed: 0 };
		const opened = await openReadonly({ native: wrapNative(new NodeNativeFileSystem(), { tracker }) });
		const scan = expectOk(await opened.services.content.scanLines(
			await resolveFile(opened.namespace, "lines.txt"),
			{ stable: true },
			{},
		));
		const lines = [];
		for await (const result of scan) lines.push(expectOk(result));
		expect(lines).toEqual([
			{ line: 1, text: "alpha", byteStart: 3, byteEnd: 8 },
			{ line: 2, text: "β", byteStart: 10, byteEnd: 12 },
			{ line: 3, text: "last", byteStart: 13, byteEnd: 17 },
		]);
		expect(tracker).toEqual({ opened: 1, closed: 1 });
	});

	it("covers bounded-read races, invalid refs and handle failures", async () => {
		await writeFile(path.join(workspace, "race.txt"), "12345");
		const baseOpened = await openReadonly();
		const file = await resolveFile(baseOpened.namespace, "race.txt");
		expect(await baseOpened.services.content.readBytes(file, { maxBytes: -1 }, {})).toMatchObject({
			ok: false,
			error: { code: "invalid-path" },
		});
		expect(await baseOpened.services.content.scanLines(file, { maxBytes: 1.5 }, {})).toMatchObject({
			ok: false,
			error: { code: "invalid-path" },
		});

		const underreported = await openReadonly({ native: wrapNative(new NodeNativeFileSystem(), {
			stat(metadata) { return { ...metadata, sizeBytes: 0 }; },
		}) });
		expect(await underreported.services.content.readBytes(
			await resolveFile(underreported.namespace, "race.txt"),
			{ maxBytes: 2 },
			{},
		)).toMatchObject({ ok: false, error: { code: "too-large" } });
		const boundedScan = expectOk(await underreported.services.content.scanLines(
			await resolveFile(underreported.namespace, "race.txt"),
			{ maxBytes: 2 },
			{},
		));
		const boundedResults = [];
		for await (const result of boundedScan) boundedResults.push(result);
		expect(boundedResults).toEqual([expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "too-large" }) })]);

		const closeFailure = await openReadonly({ native: wrapNative(new NodeNativeFileSystem(), { closeError: true }) });
		expect(await closeFailure.services.content.readBytes(
			await resolveFile(closeFailure.namespace, "race.txt"),
			{},
			{},
		)).toMatchObject({ ok: false, error: { code: "access-denied" } });

		const readFailure = await openReadonly({ native: wrapNative(new NodeNativeFileSystem(), { readError: true }) });
		expect(await readFailure.services.content.readBytes(
			await resolveFile(readFailure.namespace, "race.txt"),
			{},
			{},
		)).toMatchObject({ ok: false, error: { code: "access-denied" } });

		const wrongKind = await openReadonly({ native: wrapNative(new NodeNativeFileSystem(), {
			stat(metadata) { return { ...metadata, kind: "directory" }; },
			closeError: true,
		}) });
		expect(await wrongKind.services.content.readBytes(await resolveFile(wrongKind.namespace, "race.txt"), {}, {})).toMatchObject({
			ok: false,
			error: { code: "not-file" },
		});
		expect(await wrongKind.services.content.scanLines(await resolveFile(wrongKind.namespace, "race.txt"), {}, {})).toMatchObject({
			ok: false,
			error: { code: "not-file" },
		});
		const statFailure = await openReadonly({ native: wrapNative(new NodeNativeFileSystem(), { statError: true }) });
		expect(await statFailure.services.content.scanLines(
			await resolveFile(statFailure.namespace, "race.txt"),
			{},
			{},
		)).toMatchObject({ ok: false, error: { code: "access-denied" } });
		const initialLimit = await openReadonly();
		expect(await initialLimit.services.content.scanLines(
			await resolveFile(initialLimit.namespace, "race.txt"),
			{ maxBytes: 4 },
			{},
		)).toMatchObject({ ok: false, error: { code: "too-large" } });
		expect(await initialLimit.services.content.readText(
			await resolveFile(initialLimit.namespace, "race.txt"),
			{ maxBytes: 4 },
			{},
		)).toMatchObject({ ok: false, error: { code: "too-large" } });

		const removed = await resolveFile(baseOpened.namespace, "race.txt");
		await rm(path.join(workspace, "race.txt"));
		expect(await baseOpened.services.content.readBytes(removed, {}, {})).toMatchObject({ ok: false, error: { code: "not-found" } });
		expect(await baseOpened.services.content.scanLines(removed, {}, {})).toMatchObject({ ok: false, error: { code: "not-found" } });

		const other = path.join(temp.path, "other");
		await mkdir(other);
		await writeFile(path.join(other, "foreign.txt"), "foreign");
		const foreignNamespace = expectOk(await createWorkspaceNamespace({ workspaceRoot: other, blockedPaths: [] }));
		const foreign = await resolveFile(foreignNamespace, "foreign.txt");
		expect(await baseOpened.services.content.readBytes(foreign, {}, {})).toMatchObject({ ok: false, error: { code: "invalid-path" } });
		expect(await baseOpened.services.content.scanLines(foreign, {}, {})).toMatchObject({ ok: false, error: { code: "invalid-path" } });
		expect(await baseOpened.services.metadata.stat(foreign, {})).toMatchObject({ ok: false, error: { code: "invalid-path" } });
		expect(await baseOpened.services.metadata.list(foreignNamespace.root, {})).toMatchObject({ ok: false, error: { code: "invalid-path" } });
		expect(await baseOpened.services.traversal.walk(foreignNamespace.root, { intent: "search" }, {})).toMatchObject({
			ok: false,
			error: { code: "invalid-path" },
		});
	});

	it("binds readonly operations and active iterators to the workspace owner", async () => {
		await writeFile(path.join(workspace, "owned.txt"), "one\ntwo\n");
		const tracker = { opened: 0, closed: 0 };
		const owner = new AbortController();
		const opened = await openReadonly({
			native: wrapNative(new NodeNativeFileSystem(), { tracker }),
			ownerSignal: owner.signal,
		});
		const file = await resolveFile(opened.namespace, "owned.txt");
		const scan = expectOk(await opened.services.content.scanLines(file, {}, {}));
		const traversal = expectOk(await opened.services.traversal.walk(opened.namespace.root, { intent: "search" }, {}));

		owner.abort("lease closed");
		const scanResults = [];
		for await (const result of scan) scanResults.push(result);
		expect(scanResults).toEqual([expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "aborted" }) })]);
		expect(tracker).toEqual({ opened: 1, closed: 1 });

		const traversalEvents = [];
		for await (const event of traversal) traversalEvents.push(event);
		expect(traversalEvents).toEqual([expect.objectContaining({ type: "error", error: expect.objectContaining({ code: "aborted" }) })]);
		await expect(opened.services.content.readBytes(file, {}, { signal: new AbortController().signal }))
			.resolves.toMatchObject({ ok: false, error: { code: "aborted" } });
		await expect(opened.namespace.paths.resolveTarget("fresh.txt", { followExistingSymlink: true }, {}))
			.resolves.toMatchObject({ ok: false, error: { code: "aborted" } });
	});

	it("handles multi-chunk and binary-allowed scans, BOM-only files and repeated consumption", async () => {
		await writeFile(path.join(workspace, "large-line.txt"), `${"x".repeat(70_000)}\nend`);
		await writeFile(path.join(workspace, "chunk-crlf.txt"), `${"x".repeat(65_535)}\r\nend`);
		await writeFile(path.join(workspace, "invalid-eof.txt"), new Uint8Array([0xc3, 0x28]));
		await writeFile(path.join(workspace, "binary-lines.dat"), new Uint8Array([0x61, 0x0d, 0x62, 0x0a, 0x00]));
		await writeFile(path.join(workspace, "bom-only.txt"), buildTextBytes("", true));
		const opened = await openReadonly();
		const large = expectOk(await opened.services.content.readBytes(
			await resolveFile(opened.namespace, "large-line.txt"),
			{},
			{},
		));
		expect(large.sizeBytes).toBe(70_004);
		const boundaryScan = expectOk(await opened.services.content.scanLines(
			await resolveFile(opened.namespace, "chunk-crlf.txt"),
			{},
			{},
		));
		const boundaryLines = [];
		for await (const result of boundaryScan) boundaryLines.push(expectOk(result));
		expect(boundaryLines.map((line) => line.text.length)).toEqual([65_535, 3]);
		const invalidEof = expectOk(await opened.services.content.scanLines(
			await resolveFile(opened.namespace, "invalid-eof.txt"),
			{},
			{},
		));
		const invalidEofResults = [];
		for await (const result of invalidEof) invalidEofResults.push(result);
		expect(invalidEofResults).toEqual([expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "invalid-utf8" }) })]);

		const binary = expectOk(await opened.services.content.scanLines(
			await resolveFile(opened.namespace, "binary-lines.dat"),
			{ rejectBinary: false },
			{},
		));
		const binaryLines = [];
		for await (const result of binary) binaryLines.push(expectOk(result).text);
		expect(binaryLines).toEqual(["a", "b", "\0"]);
		const consumedAgain = [];
		for await (const result of binary) consumedAgain.push(result);
		expect(consumedAgain).toEqual([expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "invalid-path" }) })]);
		await binary.close();

		const bomOnly = expectOk(await opened.services.content.scanLines(
			await resolveFile(opened.namespace, "bom-only.txt"),
			{},
			{},
		));
		const bomLines = [];
		for await (const result of bomOnly) bomLines.push(result);
		expect(bomLines).toEqual([]);
	});

	it("reports stable scan changes and allows NUL when requested by full-text reads", async () => {
		await writeFile(path.join(workspace, "changing-lines.txt"), "line\n");
		await writeFile(path.join(workspace, "nul.txt"), new Uint8Array([0x61, 0x00, 0x62]));
		let statCalls = 0;
		const opened = await openReadonly({ native: wrapNative(new NodeNativeFileSystem(), {
			stat(metadata) {
				statCalls += 1;
				return statCalls > 1 ? { ...metadata, version: `${metadata.version}:changed` } : metadata;
			},
		}) });
		const scan = expectOk(await opened.services.content.scanLines(
			await resolveFile(opened.namespace, "changing-lines.txt"),
			{ stable: true },
			{},
		));
		const results = [];
		for await (const result of scan) results.push(result);
		expect(results.at(-1)).toMatchObject({ ok: false, error: { code: "changed-during-read" } });
		const nul = expectOk(await opened.services.content.readText(
			await resolveFile(opened.namespace, "nul.txt"),
			{ rejectBinary: false },
			{},
		));
		expect(nul.text).toBe("a\0b");
	});

	it("closes line scans after early return, abort and decoding errors", async () => {
		await writeFile(path.join(workspace, "valid.txt"), "one\ntwo\n");
		await writeFile(path.join(workspace, "invalid.txt"), new Uint8Array([0xc3, 0x28, 0x0a]));
		const tracker = { opened: 0, closed: 0 };
		const opened = await openReadonly({ native: wrapNative(new NodeNativeFileSystem(), { tracker }) });

		const early = expectOk(await opened.services.content.scanLines(await resolveFile(opened.namespace, "valid.txt"), {}, {}));
		for await (const result of early) {
			expect(result.ok).toBe(true);
			break;
		}

		const controller = new AbortController();
		const aborted = expectOk(await opened.services.content.scanLines(
			await resolveFile(opened.namespace, "valid.txt"),
			{},
			{ signal: controller.signal },
		));
		controller.abort("test");
		const abortResults = [];
		for await (const result of aborted) abortResults.push(result);
		expect(abortResults).toEqual([expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "aborted" }) })]);

		const invalid = expectOk(await opened.services.content.scanLines(await resolveFile(opened.namespace, "invalid.txt"), {}, {}));
		const invalidResults = [];
		for await (const result of invalid) invalidResults.push(result);
		expect(invalidResults).toEqual([expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "invalid-utf8" }) })]);
		expect(tracker).toEqual({ opened: 3, closed: 3 });
	});
});

describe("filesystem metadata, traversal and catalog services", () => {
	it.skipIf(process.platform === "win32")("lists and stats guarded entries while preserving symlinks and stable order", async () => {
		await writeFile(path.join(workspace, "b.txt"), "b");
		await writeFile(path.join(workspace, "a.txt"), "a");
		await writeFile(path.join(workspace, "secret.txt"), "secret");
		await symlink("a.txt", path.join(workspace, "link.txt"));
		const opened = await openReadonly({ blockedPaths: ["secret.txt"] });
		const listed = expectOk(await opened.services.metadata.list(opened.namespace.root, {}));
		const file = listed.find((entry) => entry.name === "a.txt")?.ref;
		const link = listed.find((entry) => entry.name === "link.txt")?.ref;
		if (file === undefined || link === undefined) throw new Error("Expected listed refs.");
		expect(expectOk(await opened.services.metadata.stat(file, {}))).toMatchObject({ kind: "file", sizeBytes: 1 });
		expect(expectOk(await opened.services.metadata.stat(link, {}))).toMatchObject({ kind: "symlink" });
		expect(listed.map((entry) => ({ name: entry.name, kind: entry.ref.kind, target: entry.linkTarget }))).toEqual([
			{ name: "a.txt", kind: "file", target: undefined },
			{ name: "b.txt", kind: "file", target: undefined },
			{ name: "link.txt", kind: "symlink", target: "a.txt" },
		]);
		await rm(path.join(workspace, "a.txt"));
		expect(await opened.services.metadata.stat(file, {})).toMatchObject({ ok: false, error: { code: "not-found" } });
		const controller = new AbortController();
		controller.abort("stop");
		expect(await opened.services.metadata.list(opened.namespace.root, { signal: controller.signal })).toMatchObject({
			ok: false,
			error: { code: "aborted" },
		});
	});

	it.skipIf(process.platform === "win32")("walks deterministically, prunes visibility, skips blocked paths and never follows child symlinks", async () => {
		await mkdir(path.join(workspace, "a-dir"));
		await writeFile(path.join(workspace, "a-dir", "a.txt"), "a");
		await symlink("..", path.join(workspace, "a-dir", "cycle"), "dir");
		await writeFile(path.join(workspace, "b.txt"), "b");
		await mkdir(path.join(workspace, "cache"));
		await writeFile(path.join(workspace, "cache", "drop.txt"), "drop");
		await writeFile(path.join(workspace, "cache", "keep.txt"), "keep");
		await mkdir(path.join(workspace, "ignored"));
		await writeFile(path.join(workspace, "ignored", "hidden.txt"), "hidden");
		await mkdir(path.join(workspace, "secret"));
		await writeFile(path.join(workspace, "secret", "key.txt"), "key");
		await writeFile(path.join(workspace, ".piignore"), "cache/*\n!cache/keep.txt\nignored/\n");
		const opened = await openReadonly({ blockedPaths: ["secret/"] });
		const traversal = expectOk(await opened.services.traversal.walk(opened.namespace.root, {
			intent: "search",
			includeRoot: true,
			maxEntries: 100,
		}, {}));
		const events = [];
		for await (const event of traversal) events.push(event);

		expect(events.filter((event) => event.type === "entry").map((event) => event.ref.displayPath)).toEqual([
			".", ".piignore", "a-dir", "a-dir/a.txt", "b.txt", "cache", "cache/keep.txt",
		]);
		expect(events).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "skip", path: "a-dir/cycle", reason: "symlink" }),
			expect.objectContaining({ type: "skip", path: "cache/drop.txt", reason: "ignored" }),
			expect.objectContaining({ type: "skip", path: "ignored", reason: "ignored" }),
			expect.objectContaining({ type: "skip", path: "secret", reason: "blocked" }),
		]));
	});

	it("bypasses visibility below an explicitly selected ignored root and skips it otherwise", async () => {
		await mkdir(path.join(workspace, "ignored"));
		await writeFile(path.join(workspace, "ignored", "visible-by-scope.txt"), "x");
		await writeFile(path.join(workspace, ".piignore"), "ignored/\n");
		const opened = await openReadonly();
		const ignored = expectOk(await opened.namespace.paths.resolveExisting(
			"ignored",
			{ expected: "directory", followFinalSymlink: true },
			{},
		));
		if (ignored.kind !== "directory") throw new Error("Expected directory ref.");
		const skipped = expectOk(await opened.services.traversal.walk(ignored, { intent: "search" }, {}));
		const skippedEvents = [];
		for await (const event of skipped) skippedEvents.push(event);
		expect(skippedEvents).toEqual([{ type: "skip", path: "ignored", reason: "ignored", kind: "directory" }]);

		const traversal = expectOk(await opened.services.traversal.walk(ignored, {
			intent: "search",
			explicitRoot: true,
		}, {}));
		const paths = [];
		for await (const event of traversal) if (event.type === "entry") paths.push(event.ref.displayPath);
		expect(paths).toEqual(["ignored/visible-by-scope.txt"]);
	});

	it("reports local access errors, caller limits and cancellation without corrupting later traversals", async () => {
		await mkdir(path.join(workspace, "denied"));
		await writeFile(path.join(workspace, "denied", "x.txt"), "x");
		await writeFile(path.join(workspace, "broken.txt"), "broken");
		await writeFile(path.join(workspace, "later.txt"), "later");
		const base = new NodeNativeFileSystem();
		const native = wrapNative(base, {
			lstat(pathname) {
				if (pathname.endsWith(`${path.sep}broken.txt`)) {
					throw new NativeFileSystemError("access-denied", "lstat", pathname);
				}
			},
			readdir(pathname) {
				if (pathname.endsWith(`${path.sep}denied`)) {
					throw new NativeFileSystemError("access-denied", "readdir", pathname);
				}
			},
		});
		const opened = await openReadonly({ native });
		const partial = expectOk(await opened.services.traversal.walk(opened.namespace.root, {
			intent: "search",
			maxEntries: 100,
		}, {}));
		const partialEvents = [];
		for await (const event of partial) partialEvents.push(event);
		expect(partialEvents).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "error", path: "broken.txt", error: expect.objectContaining({ code: "access-denied" }) }),
			expect.objectContaining({ type: "error", path: "denied", error: expect.objectContaining({ code: "access-denied" }) }),
			expect.objectContaining({ type: "entry", ref: expect.objectContaining({ displayPath: "later.txt" }) }),
		]));

		const limited = expectOk(await opened.services.traversal.walk(opened.namespace.root, {
			intent: "search",
			maxEntries: 1,
		}, {}));
		const limitedEvents = [];
		for await (const event of limited) limitedEvents.push(event);
		expect(limitedEvents.at(-1)).toMatchObject({ type: "skip", reason: "entry-limit" });

		const controller = new AbortController();
		const cancelled = expectOk(await opened.services.traversal.walk(opened.namespace.root, {
			intent: "search",
			maxEntries: 100,
		}, { signal: controller.signal }));
		const cancelledEvents = [];
		for await (const event of cancelled) {
			cancelledEvents.push(event);
			if (event.type === "entry") controller.abort("stop");
		}
		expect(cancelledEvents.at(-1)).toMatchObject({ type: "error", error: { code: "aborted" } });
	});

	it("returns a root operation failure when the root cannot be enumerated", async () => {
		const base = new NodeNativeFileSystem();
		const native = wrapNative(base, {
			readdir(pathname) {
				if (pathname === workspace) throw new NativeFileSystemError("access-denied", "readdir", pathname);
			},
		});
		const opened = await openReadonly({ native });
		expect(await opened.services.traversal.walk(opened.namespace.root, { intent: "search" }, {})).toMatchObject({
			ok: false,
			error: { code: "access-denied", path: "." },
		});
	});

	it("validates traversal and catalog controls at their public boundaries", async () => {
		await mkdir(path.join(workspace, "src"));
		await writeFile(path.join(workspace, "src", "a.ts"), "a");
		const opened = await openReadonly();
		expect(await opened.services.traversal.walk(opened.namespace.root, { intent: "search", maxEntries: -1 }, {})).toMatchObject({
			ok: false,
			error: { code: "invalid-path" },
		});
		const controller = new AbortController();
		controller.abort("stop");
		expect(await opened.services.traversal.walk(opened.namespace.root, { intent: "search" }, { signal: controller.signal })).toMatchObject({
			ok: false,
			error: { code: "aborted" },
		});
		expect(await opened.services.catalog.suggest(opened.namespace.root, "a", { limit: -1, maxEntries: 10 }, {})).toMatchObject({
			ok: false,
			error: { code: "invalid-path" },
		});
		expect(expectOk(await opened.services.catalog.suggest(opened.namespace.root, "a", { limit: 0, maxEntries: 10 }, {}))).toEqual([]);
		expect(await opened.services.catalog.suggest(
			opened.namespace.root,
			"a",
			{ limit: 1, maxEntries: 10 },
			{ signal: controller.signal },
		)).toMatchObject({ ok: false, error: { code: "aborted" } });
		const directories = expectOk(await opened.services.catalog.suggest(
			opened.namespace.root,
			"src",
			{ limit: 2, maxEntries: 10, kinds: ["directory"] },
			{},
		));
		expect(directories).toEqual([expect.objectContaining({ ref: expect.objectContaining({ displayPath: "src", kind: "directory" }) })]);
		const reusable = expectOk(await opened.services.traversal.walk(opened.namespace.root, { intent: "search" }, {}));
		for await (const _event of reusable) { /* consume */ }
		const repeated = [];
		for await (const event of reusable) repeated.push(event);
		expect(repeated).toEqual([expect.objectContaining({ type: "error", error: expect.objectContaining({ code: "invalid-path" }) })]);
	});

	it("ranks typo suggestions deterministically and filters invisible or unrelated paths", async () => {
		await mkdir(path.join(workspace, "src"));
		await writeFile(path.join(workspace, "src", "main.ts"), "main");
		await writeFile(path.join(workspace, "src", "main.test.ts"), "test");
		await writeFile(path.join(workspace, "src", "hidden.ts"), "hidden");
		await writeFile(path.join(workspace, ".piignore"), "src/hidden.ts\n");
		const opened = await openReadonly();
		const suggestions = expectOk(await opened.services.catalog.suggest(
			opened.namespace.root,
			"src/maim.ts",
			{ limit: 3, maxEntries: 100 },
			{},
		));
		expect(suggestions[0]).toMatchObject({ ref: { displayPath: "src/main.ts", kind: "file" } });
		expect(suggestions.every((candidate) => candidate.ref.displayPath !== "src/hidden.ts")).toBe(true);
		expect(expectOk(await opened.services.catalog.suggest(
			opened.namespace.root,
			"zzz_totally_unrelated_abc.txt",
			{ limit: 3, maxEntries: 100 },
			{},
		))).toEqual([]);
		expect(pathNameSimilarity("src/maim.ts", "src/main.ts")).toBeGreaterThan(pathNameSimilarity("src/maim.ts", "docs/readme.md"));
		expect(pathNameSimilarity("SRC\\MAIN.TS", "src/main.ts")).toBe(1);
		expect(pathNameSimilarity("main.ts", "src/main.ts")).toBe(0.98);
		expect(pathNameSimilarity("main", "src/main.ts")).toBe(0.9);
		expect(pathNameSimilarity("src/main.ts", "nested/src/main.ts")).toBe(0.98);
		expect(pathNameSimilarity("ain", "src/main.ts")).toBe(0.86);
		expect(pathNameSimilarity("", "src/main.ts")).toBe(0);
		expect(pathNameSimilarity("a", "b")).toBe(0);
		expect(compareLogicalPath("a", "b")).toBe(-1);
		expect(compareLogicalPath("b", "a")).toBe(1);
		expect(compareLogicalPath("a", "a")).toBe(0);
	});
});

interface OpenedReadonly {
	readonly namespace: WorkspaceNamespaceKernel;
	readonly services: ReadonlyFileSystemServices;
}

async function openReadonly(options: {
	readonly native?: NativeFileSystem;
	readonly blockedPaths?: readonly string[];
	readonly policy?: VisibilityPolicy;
	readonly ownerSignal?: AbortSignal;
} = {}): Promise<OpenedReadonly> {
	const native = options.native ?? new NodeNativeFileSystem();
	const namespace = expectOk(await createWorkspaceNamespace({
		workspaceRoot: workspace,
		blockedPaths: options.blockedPaths ?? [],
		native,
		...(options.ownerSignal === undefined ? {} : { context: { signal: options.ownerSignal } }),
	}));
	const visibilitySnapshot = await new WorkspaceVisibilityService(native).createSnapshot(
		workspace,
		options.policy ?? createVisibilityPolicy({ ignore: { builtinProfile: "none" } }),
	);
	return {
		namespace,
		services: createReadonlyFileSystemServices({
			native,
			namespace,
			visibilitySnapshot,
			...(options.ownerSignal === undefined ? {} : { ownerSignal: options.ownerSignal }),
		}),
	};
}

async function resolveFile(namespace: WorkspaceNamespaceKernel, input: string): Promise<FileRef> {
	const ref = expectOk(await namespace.paths.resolveExisting(input, { expected: "file", followFinalSymlink: true }, {}));
	if (ref.kind !== "file") throw new Error(`Expected file ref for ${input}.`);
	return ref;
}

function expectOk<T>(result: FsResult<T>): T {
	if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.value;
}

interface NativeOverrides {
	readonly tracker?: { opened: number; closed: number };
	readonly beforeOpen?: (path: string) => Promise<void>;
	readonly stat?: (metadata: NativeMetadata) => NativeMetadata;
	readonly lstat?: (path: string) => void;
	readonly readdir?: (path: string) => void;
	readonly closeError?: boolean;
	readonly readError?: boolean;
	readonly statError?: boolean;
}

function wrapNative(base: NativeFileSystem, overrides: NativeOverrides): NativeFileSystem {
	return {
		async lstat(pathname, options) {
			overrides.lstat?.(pathname);
			return await base.lstat(pathname, options);
		},
		stat: (pathname, options) => base.stat(pathname, options),
		realpath: (pathname, options) => base.realpath(pathname, options),
		async readdir(pathname, options) {
			overrides.readdir?.(pathname);
			return await base.readdir(pathname, options);
		},
		readlink: (pathname, options) => base.readlink(pathname, options),
		read: (pathname, options) => base.read(pathname, options),
		async open(pathname, options) {
			await overrides.beforeOpen?.(pathname);
			const handle = await base.open(pathname, options);
			overrides.tracker && (overrides.tracker.opened += 1);
			return wrapHandle(handle, overrides);
		},
		atomicReplace: (pathname, bytes, options) => base.atomicReplace(pathname, bytes, options),
		mkdir: (pathname, options) => base.mkdir(pathname, options),
	};
}

function wrapHandle(handle: NativeOpenFile, overrides: NativeOverrides): NativeOpenFile {
	return {
		async read(buffer, offset, length, position, options) {
			if (overrides.readError === true) throw new NativeFileSystemError("io-error", "read", "test");
			return await handle.read(buffer, offset, length, position, options);
		},
		async stat(options) {
			if (overrides.statError === true) throw new NativeFileSystemError("io-error", "stat", "test");
			const metadata = await handle.stat(options);
			return overrides.stat?.(metadata) ?? metadata;
		},
		async close() {
			overrides.tracker && (overrides.tracker.closed += 1);
			await handle.close();
			if (overrides.closeError === true) throw new NativeFileSystemError("io-error", "close", "test");
		},
	};
}
