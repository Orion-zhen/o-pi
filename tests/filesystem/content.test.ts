import { mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { toFileSnapshot } from "../../src/filesystem/contracts/metadata.js";
import { createWorkspaceNamespace } from "../../src/filesystem/kernel/namespace.js";
import { NativeFileSystemError, NodeNativeFileSystem } from "../../src/filesystem/platform/node/native-filesystem.js";
import { buildTextBytes } from "../../src/filesystem/services/text.js";
import { useTempDir } from "../helpers/lifecycle.js";
import { collectAsync, expectFsOk, openReadonly, resolveFile } from "./fixtures.js";
import { wrapNative } from "./readonly-fixtures.js";

const temp = useTempDir("o-pi-readonly-fs-");
let workspace: string;

beforeEach(async () => {
	workspace = path.join(temp.path, "workspace");
	await mkdir(workspace);
});

describe("filesystem content services", () => {
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
		const opened = await openReadonly(workspace, { native, blockedPaths: [`${protectedDirectory}${path.sep}`] });
		const file = await resolveFile(opened.namespace, "raced.txt");
		expect(await opened.services.content.readBytes(file, {})).toMatchObject({
			ok: false,
			error: { code: "blocked", details: { phase: "canonical" } },
		});
		expect(await new NodeNativeFileSystem().read(protectedFile)).toEqual(Buffer.from("secret"));
	});

	it("binds reads and scans to a caller-captured snapshot", async () => {
		await writeFile(path.join(workspace, "snapshot.txt"), "first\nsecond\n");
		const tracker = { opened: 0, closed: 0 };
		const opened = await openReadonly(workspace, { native: wrapNative(new NodeNativeFileSystem(), { tracker }) });
		const file = await resolveFile(opened.namespace, "snapshot.txt");
		const snapshot = toFileSnapshot(expectFsOk(await opened.services.metadata.stat(file)));

		const bytes = expectFsOk(await opened.services.content.readBytes(file, { expectedSnapshot: snapshot }));
		expect(Buffer.from(bytes.bytes).toString("utf8")).toBe("first\nsecond\n");
		const text = expectFsOk(await opened.services.content.readText(file, { expectedSnapshot: snapshot }));
		expect(text.text).toBe("first\nsecond\n");
		const scan = expectFsOk(await opened.services.content.scanLines(file, { expectedSnapshot: snapshot }));
		const lines = (await collectAsync(scan)).map((result) => expectFsOk(result).text);
		expect(lines).toEqual(["first", "second"]);
		expect(tracker).toEqual({ opened: 3, closed: 3 });
	});

	it("rejects a snapshot changed before read or scan and closes each opened handle", async () => {
		const filePath = path.join(workspace, "stale.txt");
		await writeFile(filePath, "old");
		const tracker = { opened: 0, closed: 0 };
		const opened = await openReadonly(workspace, { native: wrapNative(new NodeNativeFileSystem(), { tracker }) });
		const file = await resolveFile(opened.namespace, "stale.txt");
		const snapshot = toFileSnapshot(expectFsOk(await opened.services.metadata.stat(file)));
		await writeFile(filePath, "new-content");

		expect(await opened.services.content.readText(file, { expectedSnapshot: snapshot })).toEqual({
			ok: false,
			error: {
				code: "changed-during-read",
				message: "File changed while it was being read.",
				path: "stale.txt",
			},
		});
		expect(await opened.services.content.scanLines(file, { expectedSnapshot: snapshot })).toEqual({
			ok: false,
			error: {
				code: "changed-during-read",
				message: "File changed while it was being scanned.",
				path: "stale.txt",
			},
		});
		expect(tracker).toEqual({ opened: 2, closed: 2 });
	});

	it("rejects an identity replacement even when its size matches the expected snapshot", async () => {
		const filePath = path.join(workspace, "replaced.txt");
		const replacementPath = path.join(workspace, "replacement.txt");
		await writeFile(filePath, "old");
		await writeFile(replacementPath, "new");
		const tracker = { opened: 0, closed: 0 };
		const opened = await openReadonly(workspace, { native: wrapNative(new NodeNativeFileSystem(), { tracker }) });
		const file = await resolveFile(opened.namespace, "replaced.txt");
		const snapshot = toFileSnapshot(expectFsOk(await opened.services.metadata.stat(file)));
		await rm(filePath);
		await rename(replacementPath, filePath);
		const replacement = toFileSnapshot(expectFsOk(await opened.services.metadata.stat(file)));
		expect(replacement).toMatchObject({ sizeBytes: snapshot.sizeBytes });
		expect(replacement.identity).not.toBe(snapshot.identity);

		expect(await opened.services.content.readBytes(file, { expectedSnapshot: snapshot })).toMatchObject({
			ok: false,
			error: { code: "changed-during-read", path: "replaced.txt" },
		});
		expect(tracker).toEqual({ opened: 1, closed: 1 });
	});

	it("detects metadata changes during snapshot-bound stable reads", async () => {
		const changingPath = path.join(workspace, "changing.txt");
		await writeFile(changingPath, "content");
		let fileOpened = false;
		let revalidationCalls = 0;
		const tracker = { opened: 0, closed: 0 };
		const native = wrapNative(new NodeNativeFileSystem(), {
			tracker,
			async beforeOpen(pathname) { if (pathname === changingPath) fileOpened = true; },
			lstat(pathname, metadata) {
				if (!fileOpened || pathname !== changingPath) return metadata;
				revalidationCalls += 1;
				return revalidationCalls > 1 ? { ...metadata, version: `${metadata.version}:changed` } : metadata;
			},
		});
		const opened = await openReadonly(workspace, { native });
		const file = await resolveFile(opened.namespace, "changing.txt");
		const snapshot = toFileSnapshot(expectFsOk(await opened.services.metadata.stat(file)));
		expect(await opened.services.content.readBytes(
			file,
			{ expectedSnapshot: snapshot },
		)).toMatchObject({ ok: false, error: { code: "changed-during-read" } });
		expect(tracker).toEqual({ opened: 1, closed: 1 });
	});

	it("streams logical lines with exact byte ranges and closes on completion", async () => {
		const bytes = buildTextBytes("alpha\r\nβ\nlast", true);
		await writeFile(path.join(workspace, "lines.txt"), bytes);
		const tracker = { opened: 0, closed: 0 };
		const opened = await openReadonly(workspace, { native: wrapNative(new NodeNativeFileSystem(), { tracker }) });
		const scan = expectFsOk(await opened.services.content.scanLines(
			await resolveFile(opened.namespace, "lines.txt"),
			{},
		));
		const lines = (await collectAsync(scan)).map(expectFsOk);
		expect(lines).toEqual([
			{ line: 1, text: "alpha", byteStart: 0, byteEnd: 5 },
			{ line: 2, text: "β", byteStart: 7, byteEnd: 9 },
			{ line: 3, text: "last", byteStart: 10, byteEnd: 14 },
		]);
		expect(tracker).toEqual({ opened: 1, closed: 1 });
	});

	it("covers bounded-read races, invalid refs and handle failures", async () => {
		await writeFile(path.join(workspace, "race.txt"), "12345");
		const baseOpened = await openReadonly(workspace);
		const racePath = path.join(workspace, "race.txt");
		let raceOpened = false;
		const underreported = await openReadonly(workspace, { native: wrapNative(new NodeNativeFileSystem(), {
			async beforeOpen(pathname) { if (pathname === racePath) raceOpened = true; },
			lstat(pathname, metadata) {
				return raceOpened && pathname === racePath ? { ...metadata, sizeBytes: 0 } : metadata;
			},
		}) });
		expect(await underreported.services.content.readBytes(
			await resolveFile(underreported.namespace, "race.txt"),
			{ maxBytes: 2 },
		)).toMatchObject({ ok: false, error: { code: "too-large" } });
		const boundedScan = expectFsOk(await underreported.services.content.scanLines(
			await resolveFile(underreported.namespace, "race.txt"),
			{ maxBytes: 2 },
		));
		const boundedResults = await collectAsync(boundedScan);
		expect(boundedResults).toEqual([expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "too-large" }) })]);

		const closeFailure = await openReadonly(workspace, { native: wrapNative(new NodeNativeFileSystem(), { closeError: true }) });
		expect(await closeFailure.services.content.readBytes(
			await resolveFile(closeFailure.namespace, "race.txt"),
			{},
		)).toMatchObject({ ok: false, error: { code: "access-denied" } });

		const readFailure = await openReadonly(workspace, { native: wrapNative(new NodeNativeFileSystem(), { readError: true }) });
		expect(await readFailure.services.content.readBytes(
			await resolveFile(readFailure.namespace, "race.txt"),
			{},
		)).toMatchObject({ ok: false, error: { code: "access-denied" } });

		const wrongKind = await openReadonly(workspace, { native: wrapNative(new NodeNativeFileSystem(), {
			stat(metadata) { return { ...metadata, kind: "directory" }; },
			closeError: true,
		}) });
		expect(await wrongKind.services.content.readBytes(await resolveFile(wrongKind.namespace, "race.txt"), {})).toMatchObject({
			ok: false,
			error: { code: "not-file" },
		});
		expect(await wrongKind.services.content.scanLines(await resolveFile(wrongKind.namespace, "race.txt"), {})).toMatchObject({
			ok: false,
			error: { code: "not-file" },
		});
		let openedRace = false;
		const revalidationFailure = await openReadonly(workspace, { native: wrapNative(new NodeNativeFileSystem(), {
			async beforeOpen(pathname) { if (pathname.endsWith("race.txt")) openedRace = true; },
			lstat(pathname, metadata) {
				if (openedRace && pathname.endsWith("race.txt")) {
					throw new NativeFileSystemError("access-denied", "lstat", pathname);
				}
				return metadata;
			},
		}) });
		expect(await revalidationFailure.services.content.scanLines(
			await resolveFile(revalidationFailure.namespace, "race.txt"),
			{},
		)).toMatchObject({ ok: false, error: { code: "access-denied" } });
		const initialLimit = await openReadonly(workspace);
		expect(await initialLimit.services.content.scanLines(
			await resolveFile(initialLimit.namespace, "race.txt"),
			{ maxBytes: 4 },
		)).toMatchObject({ ok: false, error: { code: "too-large" } });
		expect(await initialLimit.services.content.readText(
			await resolveFile(initialLimit.namespace, "race.txt"),
			{ maxBytes: 4 },
		)).toMatchObject({ ok: false, error: { code: "too-large" } });

		const removed = await resolveFile(baseOpened.namespace, "race.txt");
		await rm(path.join(workspace, "race.txt"));
		expect(await baseOpened.services.content.readBytes(removed, {})).toMatchObject({ ok: false, error: { code: "not-found" } });
		expect(await baseOpened.services.content.scanLines(removed, {})).toMatchObject({ ok: false, error: { code: "not-found" } });

		const other = path.join(temp.path, "other");
		await mkdir(other);
		await writeFile(path.join(other, "foreign.txt"), "foreign");
		const foreignNamespace = expectFsOk(await createWorkspaceNamespace({ workspaceRoot: other, blockedPaths: [] }));
		const foreign = await resolveFile(foreignNamespace, "foreign.txt");
		expect(await baseOpened.services.content.readBytes(foreign, {})).toMatchObject({ ok: false, error: { code: "invalid-path" } });
		expect(await baseOpened.services.content.scanLines(foreign, {})).toMatchObject({ ok: false, error: { code: "invalid-path" } });
		expect(await baseOpened.services.metadata.stat(foreign)).toMatchObject({ ok: false, error: { code: "invalid-path" } });
		expect(await baseOpened.services.metadata.list(foreignNamespace.root)).toMatchObject({ ok: false, error: { code: "invalid-path" } });
		expect(await baseOpened.services.traversal.walk(foreignNamespace.root, { intent: "search" })).toMatchObject({
			ok: false,
			error: { code: "invalid-path" },
		});
	});

	it("binds readonly operations and active iterators to the workspace owner", async () => {
		await writeFile(path.join(workspace, "owned.txt"), "one\ntwo\n");
		const tracker = { opened: 0, closed: 0 };
		const owner = new AbortController();
		const opened = await openReadonly(workspace, {
			native: wrapNative(new NodeNativeFileSystem(), { tracker }),
			ownerSignal: owner.signal,
		});
		const file = await resolveFile(opened.namespace, "owned.txt");
		const scan = expectFsOk(await opened.services.content.scanLines(file, {}));
		const traversal = expectFsOk(await opened.services.traversal.walk(opened.namespace.root, { intent: "search" }));

		owner.abort("lease closed");
		const scanResults = await collectAsync(scan);
		expect(scanResults).toEqual([expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "aborted" }) })]);
		expect(tracker).toEqual({ opened: 1, closed: 1 });

		const traversalEvents = await collectAsync(traversal);
		expect(traversalEvents).toEqual([expect.objectContaining({ type: "error", error: expect.objectContaining({ code: "aborted" }) })]);
		await expect(opened.services.content.readBytes(file, {}))
			.resolves.toMatchObject({ ok: false, error: { code: "aborted" } });
		await expect(opened.namespace.paths.resolveTarget("fresh.txt", { followExistingSymlink: true }))
			.resolves.toMatchObject({ ok: false, error: { code: "aborted" } });
	});

	it.each([1, 2, 4])("streams a %d MiB newline-free file as one line", async (sizeMiB) => {
		const sizeBytes = sizeMiB * 1024 * 1024;
		await writeFile(path.join(workspace, "single-line.txt"), Buffer.alloc(sizeBytes, 0x78));
		const opened = await openReadonly(workspace);
		const scan = expectFsOk(await opened.services.content.scanLines(
			await resolveFile(opened.namespace, "single-line.txt"),
			{},
		));

		const lines = (await collectAsync(scan)).map(expectFsOk);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ line: 1, byteStart: 0, byteEnd: sizeBytes });
		expect(lines[0]?.text).toHaveLength(sizeBytes);
	});

	it("handles multi-chunk scans, binary rejection and BOM-only files", async () => {
		await writeFile(path.join(workspace, "large-line.txt"), `${"x".repeat(70_000)}\nend`);
		await writeFile(path.join(workspace, "chunk-crlf.txt"), `${"x".repeat(65_535)}\r\nend`);
		await writeFile(path.join(workspace, "chunk-utf8.txt"), `${"x".repeat(65_535)}β\nend`);
		await writeFile(path.join(workspace, "invalid-eof.txt"), new Uint8Array([0xc3, 0x28]));
		await writeFile(path.join(workspace, "binary-lines.dat"), new Uint8Array([0x61, 0x0d, 0x62, 0x0a, 0x00]));
		await writeFile(path.join(workspace, "bom-only.txt"), buildTextBytes("", true));
		await writeFile(path.join(workspace, "bom-cr.txt"), buildTextBytes("\r", true));
		const opened = await openReadonly(workspace);
		const large = expectFsOk(await opened.services.content.readBytes(
			await resolveFile(opened.namespace, "large-line.txt"),
			{},
		));
		expect(large.sizeBytes).toBe(70_004);
		const boundaryScan = expectFsOk(await opened.services.content.scanLines(
			await resolveFile(opened.namespace, "chunk-crlf.txt"),
			{},
		));
		const boundaryLines = (await collectAsync(boundaryScan)).map(expectFsOk);
		expect(boundaryLines.map((line) => ({ length: line.text.length, start: line.byteStart, end: line.byteEnd }))).toEqual([
			{ length: 65_535, start: 0, end: 65_535 },
			{ length: 3, start: 65_537, end: 65_540 },
		]);
		const utf8BoundaryScan = expectFsOk(await opened.services.content.scanLines(
			await resolveFile(opened.namespace, "chunk-utf8.txt"),
			{},
		));
		const utf8BoundaryLines = (await collectAsync(utf8BoundaryScan)).map(expectFsOk);
		expect(utf8BoundaryLines.map((line) => ({ length: line.text.length, start: line.byteStart, end: line.byteEnd }))).toEqual([
			{ length: 65_536, start: 0, end: 65_537 },
			{ length: 3, start: 65_538, end: 65_541 },
		]);
		const invalidEof = expectFsOk(await opened.services.content.scanLines(
			await resolveFile(opened.namespace, "invalid-eof.txt"),
			{},
		));
		const invalidEofResults = await collectAsync(invalidEof);
		expect(invalidEofResults).toEqual([expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "invalid-utf8" }) })]);

		const binary = expectFsOk(await opened.services.content.scanLines(
			await resolveFile(opened.namespace, "binary-lines.dat"),
			{},
		));
		expect(await collectAsync(binary)).toEqual([
			expect.objectContaining({ ok: true }),
			expect.objectContaining({ ok: true }),
			expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "binary" }) }),
		]);
		expect(await collectAsync(binary)).toEqual([]);
		await binary.close();

		const bomOnly = expectFsOk(await opened.services.content.scanLines(
			await resolveFile(opened.namespace, "bom-only.txt"),
			{},
		));
		const bomLines = await collectAsync(bomOnly);
		expect(bomLines).toEqual([]);

		const bomCr = expectFsOk(await opened.services.content.scanLines(
			await resolveFile(opened.namespace, "bom-cr.txt"),
			{},
		));
		const bomCrLines = (await collectAsync(bomCr)).map(expectFsOk);
		expect(bomCrLines).toEqual([{ line: 1, text: "", byteStart: 0, byteEnd: 0 }]);
	});

	it("reports stable changes after a snapshot-bound scan and rejects NUL in full-text reads", async () => {
		const changingPath = path.join(workspace, "changing-lines.txt");
		await writeFile(changingPath, "line\n");
		await writeFile(path.join(workspace, "nul.txt"), new Uint8Array([0x61, 0x00, 0x62]));
		let changingOpened = false;
		let revalidationCalls = 0;
		const tracker = { opened: 0, closed: 0 };
		const opened = await openReadonly(workspace, { native: wrapNative(new NodeNativeFileSystem(), {
			tracker,
			async beforeOpen(pathname) { if (pathname === changingPath) changingOpened = true; },
			lstat(pathname, metadata) {
				if (!changingOpened || pathname !== changingPath) return metadata;
				revalidationCalls += 1;
				return revalidationCalls > 1 ? { ...metadata, version: `${metadata.version}:changed` } : metadata;
			},
		}) });
		const changingFile = await resolveFile(opened.namespace, "changing-lines.txt");
		const snapshot = toFileSnapshot(expectFsOk(await opened.services.metadata.stat(changingFile)));
		const scan = expectFsOk(await opened.services.content.scanLines(
			changingFile,
			{ expectedSnapshot: snapshot },
		));
		const results = await collectAsync(scan);
		expect(results.at(-1)).toMatchObject({ ok: false, error: { code: "changed-during-read" } });
		expect(tracker).toEqual({ opened: 1, closed: 1 });
		expect(await opened.services.content.readText(
			await resolveFile(opened.namespace, "nul.txt"),
			{},
		)).toMatchObject({ ok: false, error: { code: "binary" } });
	});

	it("closes line scans after early return, abort and decoding errors", async () => {
		await writeFile(path.join(workspace, "valid.txt"), "one\ntwo\n");
		await writeFile(path.join(workspace, "invalid.txt"), new Uint8Array([0xc3, 0x28, 0x0a]));
		const tracker = { opened: 0, closed: 0 };
		const native = wrapNative(new NodeNativeFileSystem(), { tracker });
		const opened = await openReadonly(workspace, { native });
		const validFile = await resolveFile(opened.namespace, "valid.txt");
		const snapshot = toFileSnapshot(expectFsOk(await opened.services.metadata.stat(validFile)));

		const early = expectFsOk(await opened.services.content.scanLines(validFile, { expectedSnapshot: snapshot }));
		for await (const result of early) {
			expect(result.ok).toBe(true);
			break;
		}

		const controller = new AbortController();
		const abortedOpened = await openReadonly(workspace, { native, ownerSignal: controller.signal });
		const abortedFile = await resolveFile(abortedOpened.namespace, "valid.txt");
		const aborted = expectFsOk(await abortedOpened.services.content.scanLines(
			abortedFile,
			{ expectedSnapshot: snapshot },
		));
		controller.abort("test");
		const abortResults = await collectAsync(aborted);
		expect(abortResults).toEqual([expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "aborted" }) })]);

		const invalid = expectFsOk(await opened.services.content.scanLines(await resolveFile(opened.namespace, "invalid.txt"), {}));
		const invalidResults = await collectAsync(invalid);
		expect(invalidResults).toEqual([expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "invalid-utf8" }) })]);
		expect(tracker).toEqual({ opened: 3, closed: 3 });
	});
});
