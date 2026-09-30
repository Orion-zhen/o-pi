import { mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { toFileSnapshot } from "../../../src/harness/filesystem/contracts/metadata.ts";
import { NodeNativeFileSystem } from "../../../src/harness/filesystem/platform/node/native-filesystem.ts";
import { useTempDir } from "../../helpers/lifecycle.ts";
import { buildTextBytes, collectAsync, expectFsOk, openReadonly, resolveFile } from "./fixtures.ts";
import { wrapNative } from "./readonly-fixtures.ts";

const temp = useTempDir("o-pi-readonly-fs-");
let workspace: string;

beforeEach(async () => {
	workspace = path.join(temp.path, "workspace");
	await mkdir(workspace);
});

describe("filesystem content services", () => {
	it.each([false, true])("未知读取异常仍关闭 handle，closeError=%s", async (closeError) => {
		await writeFile(path.join(workspace, "unexpected.txt"), "content");
		const tracker = { opened: 0, closed: 0 };
		const failure = new Error("unexpected read failure");
		const opened = await openReadonly(workspace, {
			native: wrapNative(new NodeNativeFileSystem(), {
				tracker,
				closeError,
				beforeRead() { throw failure; },
			}),
		});
		await expect(opened.readBytes("unexpected.txt")).rejects.toBe(failure);
		expect(tracker).toEqual({ opened: 1, closed: 1 });
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
		const opened = await openReadonly(workspace, { native, blockedPaths: [`${protectedDirectory}${path.sep}`] });
		const file = await resolveFile(opened.namespace, "raced.txt");
		expect(await opened.services.content.readBytes(file, {})).toMatchObject({
			ok: false,
			error: { code: "blocked", details: { phase: "canonical" } },
		});
		expect(await new NodeNativeFileSystem().read(protectedFile)).toEqual(Buffer.from("secret"));
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
				message: expect.any(String),
				path: "stale.txt",
			},
		});
		expect(await opened.services.content.scanLines(file, { expectedSnapshot: snapshot })).toEqual({
			ok: false,
			error: {
				code: "changed-during-read",
				message: expect.any(String),
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





	it("handles multi-chunk scans, binary rejection and BOM-only files", async () => {
		await writeFile(path.join(workspace, "large-line.txt"), `${"x".repeat(70_000)}\nend`);
		await writeFile(path.join(workspace, "chunk-crlf.txt"), `${"x".repeat(65_535)}\r\nend`);
		await writeFile(path.join(workspace, "chunk-utf8.txt"), `${"x".repeat(65_535)}β\nend`);
		await writeFile(path.join(workspace, "invalid-eof.txt"), new Uint8Array([0xc3, 0x28]));
		await writeFile(path.join(workspace, "binary-lines.dat"), new Uint8Array([0x61, 0x0d, 0x62, 0x0a, 0x00]));
		await writeFile(path.join(workspace, "bom-only.txt"), buildTextBytes("", true));
		await writeFile(path.join(workspace, "bom-cr.txt"), buildTextBytes("\r", true));
		const opened = await openReadonly(workspace);
		const large = expectFsOk(await opened.readBytes("large-line.txt"));
		expect(large.sizeBytes).toBe(70_004);
		const boundaryScan = expectFsOk(await opened.scanLines("chunk-crlf.txt"));
		const boundaryLines = (await collectAsync(boundaryScan)).map(expectFsOk);
		expect(boundaryLines.map((line) => ({ length: line.text.length, start: line.byteStart, end: line.byteEnd }))).toEqual([
			{ length: 65_535, start: 0, end: 65_535 },
			{ length: 3, start: 65_537, end: 65_540 },
		]);
		const utf8BoundaryScan = expectFsOk(await opened.scanLines("chunk-utf8.txt"));
		const utf8BoundaryLines = (await collectAsync(utf8BoundaryScan)).map(expectFsOk);
		expect(utf8BoundaryLines.map((line) => ({ length: line.text.length, start: line.byteStart, end: line.byteEnd }))).toEqual([
			{ length: 65_536, start: 0, end: 65_537 },
			{ length: 3, start: 65_538, end: 65_541 },
		]);
		const invalidEof = expectFsOk(await opened.scanLines("invalid-eof.txt"));
		const invalidEofResults = await collectAsync(invalidEof);
		expect(invalidEofResults).toEqual([expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "invalid-utf8" }) })]);

		const binary = expectFsOk(await opened.scanLines("binary-lines.dat"));
		expect(await collectAsync(binary)).toEqual([
			expect.objectContaining({ ok: true }),
			expect.objectContaining({ ok: true }),
			expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "binary" }) }),
		]);
		expect(await collectAsync(binary)).toEqual([]);
		await binary.close();

		const bomOnly = expectFsOk(await opened.scanLines("bom-only.txt"));
		const bomLines = await collectAsync(bomOnly);
		expect(bomLines).toEqual([]);

		const bomCr = expectFsOk(await opened.scanLines("bom-cr.txt"));
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
		expect(await opened.readText("nul.txt")).toMatchObject({ ok: false, error: { code: "binary" } });
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

		const invalid = expectFsOk(await opened.scanLines("invalid.txt"));
		const invalidResults = await collectAsync(invalid);
		expect(invalidResults).toEqual([expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "invalid-utf8" }) })]);
		expect(tracker).toEqual({ opened: 3, closed: 3 });
	});
});
