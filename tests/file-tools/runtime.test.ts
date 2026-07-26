import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FileRef, TargetRef } from "../../src/filesystem/contracts/path.js";
import type { FilesystemPolicy } from "../../src/filesystem/contracts/policy.js";
import type { FsResult } from "../../src/filesystem/contracts/result.js";
import { NodeNativeFileSystem, type NativeFileSystem } from "../../src/filesystem/platform/node/native-filesystem.js";
import { FileSystemRuntime, type OpenWorkspaceOptions } from "../../src/filesystem/runtime.js";
import { createVisibilityPolicy } from "../../src/filesystem/services/visibility/policy.js";
import { contentHash } from "../../src/filesystem/services/text.js";
import {
	FileToolsConfigProvider,
	type FileToolsConfig,
	type FileToolsConfigLoader,
} from "../../src/file-tools/config.js";
import { FileToolsHost, type FileToolsInvocation } from "../../src/file-tools/runtime/host.js";
import { fail, isFailed, type ToolOutcome } from "../../src/file-tools/shared/result.js";
import { defaultFileToolLimits } from "../../src/file-tools/tool-limits.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-file-tools-host-");
preserveEnv("PI_FILE_TOOLS_CONFIG", "PI_FILE_TOOLS_PROJECT_CONFIG", "PI_FILE_TOOLS_PROJECT_ROOT");
let workspace: string;
let hosts: FileToolsHost[];

beforeEach(async () => {
	workspace = path.join(temp.path, "workspace");
	await mkdir(workspace);
	hosts = [];
});

afterEach(() => {
	for (const host of hosts) host.dispose();
});

describe("FileToolsHost runtime", () => {
	it("owns and idempotently disposes its config provider cache", async () => {
		const userConfig = path.join(temp.path, "provider-file-tools.jsonc");
		await writeFile(userConfig, "{}\n");
		process.env.PI_FILE_TOOLS_CONFIG = userConfig;
		delete process.env.PI_FILE_TOOLS_PROJECT_CONFIG;
		delete process.env.PI_FILE_TOOLS_PROJECT_ROOT;
		const provider = new FileToolsConfigProvider();
		expect(await provider.load(workspace)).toMatchObject({ limits: { ls_entries: expect.any(Number) } });
		provider.dispose();
		provider.dispose();
		await expect(provider.load(workspace)).resolves.toMatchObject({ status: "failed", error: { code: "CONFIG_ERROR" } });
	});
	it("returns config failures before any workspace I/O", async () => {
		const counted = countingNative();
		const config: FileToolsConfigLoader = {
			async load() { return fail("CONFIG_ERROR", "invalid project config"); },
		};
		const host = track(new FileToolsHost({ config, filesystem: new FileSystemRuntime({ native: counted.native }) }));
		await expect(host.open({ cwd: workspace, sessionId: "config" })).resolves.toMatchObject({
			status: "failed",
			error: { code: "CONFIG_ERROR" },
		});
		expect(counted.calls()).toBe(0);
	});

	it("honors cancellation before or immediately after config loading without workspace I/O", async () => {
		const counted = countingNative();
		const before = new AbortController();
		before.abort();
		const host = track(new FileToolsHost({ config: staticConfig(), filesystem: new FileSystemRuntime({ native: counted.native }) }));
		await expect(host.open({ cwd: workspace, sessionId: "before", signal: before.signal })).resolves.toMatchObject({
			status: "failed",
			error: { code: "OPERATION_ABORTED" },
		});

		const during = new AbortController();
		const config: FileToolsConfigLoader = {
			async load() {
				during.abort();
				return fileToolsConfig();
			},
		};
		const afterConfig = track(new FileToolsHost({ config, filesystem: new FileSystemRuntime({ native: counted.native }) }));
		await expect(afterConfig.open({ cwd: workspace, sessionId: "during", signal: during.signal })).resolves.toMatchObject({
			status: "failed",
			error: { code: "OPERATION_ABORTED" },
		});
		expect(counted.calls()).toBe(0);
	});

	it("loads invocation-cwd config and returns CONFIG_ERROR before workspace I/O", async () => {
		const userConfig = path.join(temp.path, "user-file-tools.jsonc");
		const projectConfig = path.join(temp.path, "project-file-tools.jsonc");
		await writeFile(userConfig, "{}\n");
		await writeFile(projectConfig, JSON.stringify({ limits: { ls_entries: 0 } }));
		process.env.PI_FILE_TOOLS_CONFIG = userConfig;
		process.env.PI_FILE_TOOLS_PROJECT_CONFIG = projectConfig;
		delete process.env.PI_FILE_TOOLS_PROJECT_ROOT;
		const counted = countingNative();
		const host = track(new FileToolsHost({ filesystem: new FileSystemRuntime({ native: counted.native }) }));

		await expect(host.open({ cwd: workspace, sessionId: "project-config" })).resolves.toMatchObject({
			status: "failed",
			error: { code: "CONFIG_ERROR" },
		});
		expect(counted.calls()).toBe(0);
	});

	it("does not start workspace I/O when shutdown wins an in-flight config load", async () => {
		const counted = countingNative();
		const release = deferredValue<ToolOutcome<FileToolsConfig>>();
		let disposed = 0;
		const config = {
			load: () => release.promise,
			dispose() { disposed += 1; },
		};
		const host = track(new FileToolsHost({ config, filesystem: new FileSystemRuntime({ native: counted.native }) }));
		const opening = host.open({ cwd: workspace, sessionId: "shutdown" });
		host.dispose();
		host.dispose();
		release.resolve(fileToolsConfig());
		await expect(opening).resolves.toMatchObject({ status: "failed", error: { code: "OPERATION_ABORTED" } });
		expect(counted.calls()).toBe(0);
		expect(disposed).toBe(1);
	});

	it("cleans a newly created session when workspace open fails", async () => {
		const host = track(new FileToolsHost({ config: staticConfig() }));
		await expect(host.open({ cwd: path.join(workspace, "missing"), sessionId: "retry" })).resolves.toMatchObject({
			status: "failed",
			error: { code: "PATH_NOT_FOUND" },
		});
		const opened = await openHost(host, "retry");
		expect(opened.observation.get(await resolveTarget(opened, "new.txt"))).toBeUndefined();
	});

	it("closes a workspace that finishes opening during host shutdown", async () => {
		const runtime = new DisposeAfterOpenRuntime();
		const host = track(new FileToolsHost({ config: staticConfig(), filesystem: runtime }));
		runtime.afterOpen = () => { host.dispose(); };
		await expect(host.open({ cwd: workspace, sessionId: "race" })).resolves.toMatchObject({
			status: "failed",
			error: { code: "OPERATION_ABORTED" },
		});
	});

	it.skipIf(process.platform === "win32")("shares canonical observations within a session and isolates sessions", async () => {
		await writeFile(path.join(workspace, "real.txt"), "content");
		await symlink(path.join(workspace, "real.txt"), path.join(workspace, "alias.txt"));
		const host = track(new FileToolsHost({ config: staticConfig() }));
		const first = await openHost(host, "same");
		const second = await openHost(host, "same");
		const isolated = await openHost(host, "other");
		const real = await resolveFile(first, "real.txt");
		const alias = await resolveFile(second, "alias.txt");
		const isolatedRef = await resolveFile(isolated, "real.txt");
		const version = { hash: contentHash(bytes("content")), sizeBytes: bytes("content").byteLength };

		expect(first.observation.remember(real, version)).toBe(true);
		expect(second.observation).toBe(first.observation);
		expect(second.observation.get(alias)).toEqual(version);
		expect(isolated.observation.get(isolatedRef)).toBeUndefined();
		expect(first.observation.remember(isolatedRef, version)).toBe(false);
		expect(first.observation.forget(isolatedRef)).toBe(false);
		expect(second.observation.forget(alias)).toBe(true);
		expect(first.observation.get(real)).toBeUndefined();
		first.observation.remember(real, version);
		second.observation.clear();
		expect(first.observation.get(real)).toBeUndefined();
		const detach = first.observation.attach(first.nativeBridge);
		detach();
		detach();
	});

	it("updates observations before releasing the mutation queue for a concurrent edit", async () => {
		const host = track(new FileToolsHost({ config: staticConfig() }));
		const opened = await openHost(host, "ordered");
		const target = await resolveTarget(opened, "ordered.txt");
		const entered = deferredVoid();
		const release = deferredVoid();
		const first = opened.filesystem.mutations.run(target, { createParents: false }, async () => {
			entered.resolve();
			await release.promise;
			return { type: "commit", bytes: bytes("one") };
		}, opened.context);
		await entered.promise;
		let observedBySecond: string | undefined;
		const second = opened.filesystem.mutations.run(target, { createParents: false }, () => {
			observedBySecond = opened.observation.get(target)?.hash;
			return { type: "commit", bytes: bytes("two") };
		}, opened.context);
		release.resolve();
		expect(expectOk(await first)).toMatchObject({ committed: true });
		expect(expectOk(await second)).toMatchObject({ committed: true });
		expect(observedBySecond).toBe(contentHash(bytes("one")));
		expect(opened.observation.get(target)).toEqual({ hash: contentHash(bytes("two")), sizeBytes: 3 });
	});

	it("supports observation-based external stale detection inside the mutation session", async () => {
		await writeFile(path.join(workspace, "stale.txt"), "read-version");
		const host = track(new FileToolsHost({ config: staticConfig() }));
		const opened = await openHost(host, "stale");
		const file = await resolveFile(opened, "stale.txt");
		const target = await resolveTarget(opened, "stale.txt");
		const read = expectOk(await opened.filesystem.content.readBytes(file, { stable: true }, opened.context));
		opened.observation.remember(file, read);
		await writeFile(path.join(workspace, "stale.txt"), "external");

		const result = await opened.filesystem.mutations.run(target, { createParents: false }, (snapshot) => {
			const observed = opened.observation.get(target);
			if (!snapshot.exists || observed?.hash !== snapshot.hash) return { type: "reject", reason: "stale" };
			return { type: "commit", bytes: bytes("unsafe") };
		}, opened.context);
		expect(expectOk(result)).toMatchObject({ committed: false, reason: "stale" });
	});

	it("owns workspace, session, and host lifecycle with idempotent disposal", async () => {
		const host = track(new FileToolsHost({ config: staticConfig() }));
		const opened = await openHost(host, "lifecycle");
		const target = await resolveTarget(opened, "life.txt");
		expect(expectOk(await opened.filesystem.mutations.overwrite(
			target,
			bytes("life"),
			{ createParents: false },
			opened.context,
		))).toMatchObject({ created: true });
		expect(opened.limits.ls_entries).toBe(defaultFileToolLimits().ls_entries);

		host.disposeSession("lifecycle");
		host.disposeSession("lifecycle");
		expect(opened.observation.get(target)).toBeUndefined();
		const detached = opened.observation.attach(opened.nativeBridge);
		detached();
		expect(opened.observation.remember(target, { hash: "unused", sizeBytes: 0 })).toBe(false);
		expect(opened.observation.forget(target)).toBe(false);
		opened.observation.dispose();
		opened.dispose();
		opened.dispose();
		expect(opened.disposed).toBe(true);
		await expect(opened.filesystem.paths.resolveTarget(
			"after-dispose.txt",
			{ followExistingSymlink: true },
			opened.context,
		)).resolves.toMatchObject({ ok: false, error: { code: "aborted" } });

		host.dispose();
		host.dispose();
		await expect(host.open({ cwd: workspace, sessionId: "after" })).resolves.toMatchObject({
			status: "failed",
			error: { code: "OPERATION_ABORTED" },
		});
	});
});

async function openHost(host: FileToolsHost, sessionId: string): Promise<FileToolsInvocation> {
	const opened = await host.open({ cwd: workspace, sessionId });
	if (isFailed(opened)) throw new Error(opened.error.message);
	return opened;
}

async function resolveFile(opened: FileToolsInvocation, input: string): Promise<FileRef> {
	const resolved = expectOk(await opened.filesystem.paths.resolveExisting(
		input,
		{ expected: "file", followFinalSymlink: true },
		opened.context,
	));
	if (resolved.kind !== "file") throw new Error("Expected a file ref.");
	return resolved;
}

async function resolveTarget(opened: FileToolsInvocation, input: string): Promise<TargetRef> {
	return expectOk(await opened.filesystem.paths.resolveTarget(input, { followExistingSymlink: true }, opened.context));
}

function expectOk<T>(result: FsResult<T>): T {
	expect(result).toMatchObject({ ok: true });
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}

function staticConfig(): FileToolsConfigLoader {
	return { async load() { return fileToolsConfig(); } };
}

function fileToolsConfig(): FileToolsConfig {
	return { filesystem: policy(), limits: defaultFileToolLimits() };
}

function policy(): FilesystemPolicy {
	const visibility = createVisibilityPolicy();
	return { blockedPaths: [".git/"], visibility, fingerprint: visibility.fingerprint };
}

function bytes(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function deferredValue<T>() {
	let resolver: ((value: T | PromiseLike<T>) => void) | undefined;
	const promise = new Promise<T>((resolve) => { resolver = resolve; });
	return { promise, resolve(value: T) { resolver?.(value); } };
}

function deferredVoid() {
	let resolver: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => { resolver = resolve; });
	return { promise, resolve() { resolver?.(); } };
}

function track(host: FileToolsHost): FileToolsHost {
	hosts.push(host);
	return host;
}

class DisposeAfterOpenRuntime extends FileSystemRuntime {
	afterOpen: (() => void) | undefined;

	override async open(options: OpenWorkspaceOptions) {
		const result = await super.open(options);
		this.afterOpen?.();
		return result;
	}
}

function countingNative(): { readonly native: NativeFileSystem; calls(): number } {
	const base = new NodeNativeFileSystem();
	let count = 0;
	const called = <T extends readonly unknown[], R>(operation: (...args: T) => Promise<R>) => async (...args: T): Promise<R> => {
		count += 1;
		return await operation(...args);
	};
	return {
		native: {
			lstat: called((file, options) => base.lstat(file, options)),
			stat: called((file, options) => base.stat(file, options)),
			realpath: called((file, options) => base.realpath(file, options)),
			readdir: called((directory, options) => base.readdir(directory, options)),
			readlink: called((file, options) => base.readlink(file, options)),
			read: called((file, options) => base.read(file, options)),
			open: called((file, options) => base.open(file, options)),
			write: called((file, value, options) => base.write(file, value, options)),
			mkdir: called((directory, options) => base.mkdir(directory, options)),
		},
		calls: () => count,
	};
}
