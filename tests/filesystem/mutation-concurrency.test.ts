import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { FileSystemRuntime } from "../../src/filesystem/runtime.js";
import { MutationQueue } from "../../src/filesystem/platform/node/mutation-queue.js";
import { contentHash } from "../../src/filesystem/services/text.js";
import { deferredVoid as deferred, expectFsOk as expectOk, textBytes as bytes } from "./fixtures.js";
import { commitBytes, useMutationFixture } from "./mutation-fixtures.js";

const test = useMutationFixture("o-pi-mutation-concurrency-");
const { openMutation, openRuntime, policy, resolveTarget, track } = test;
let workspace: string;
beforeEach(() => { workspace = test.workspace; });

describe("filesystem mutation concurrency", () => {
	it("releases active queue entries and rejects waiters and new work when disposed", async () => {
		const queue = new MutationQueue();
		const entered = deferred();
		const release = deferred();
		const active = queue.run("same", undefined, async () => {
			entered.resolve();
			await release.promise;
			return "active";
		});
		await entered.promise;
		const waiting = queue.run("same", undefined, async () => "waiting");
		queue.dispose();
		queue.dispose();
		await expect(waiting).rejects.toMatchObject({ reason: "disposed" });
		await expect(queue.run("new", undefined, async () => "new")).rejects.toMatchObject({ reason: "disposed" });
		release.resolve();
		await expect(active).resolves.toBe("active");

		const abortedQueue = new MutationQueue();
		const before = new AbortController();
		before.abort();
		await expect(abortedQueue.run("before", before.signal, async () => "unexpected")).rejects.toMatchObject({ reason: "aborted" });
		const controller = new AbortController();
		const aborted = abortedQueue.run("aborted", controller.signal, async () => "unexpected");
		controller.abort();
		await expect(aborted).rejects.toMatchObject({ reason: "aborted" });
		abortedQueue.dispose();
	});
	it("serializes the same target, runs different targets concurrently, and releases after exceptions", async () => {
		const opened = await openRuntime();
		const same = await resolveTarget(opened, "same.txt");
		const other = await resolveTarget(opened, "other.txt");
		const firstEntered = deferred();
		const firstRelease = deferred();
		let secondEntered = false;
		const first = opened.filesystem.mutations.run(same, { createParents: false }, async () => {
			firstEntered.resolve();
			await firstRelease.promise;
			return { type: "commit", bytes: bytes("one") };
		});
		await firstEntered.promise;
		const second = opened.filesystem.mutations.run(same, { createParents: false }, () => {
			secondEntered = true;
			return { type: "commit", bytes: bytes("two") };
		});
		const otherEntered = deferred();
		const otherRelease = deferred();
		const parallel = opened.filesystem.mutations.run(other, { createParents: false }, async () => {
			otherEntered.resolve();
			await otherRelease.promise;
			return { type: "reject", reason: "parallel-done" };
		});
		await otherEntered.promise;
		expect(secondEntered).toBe(false);
		otherRelease.resolve();
		firstRelease.resolve();
		expect(expectOk(await first)).toMatchObject({ committed: true });
		expect(expectOk(await second)).toMatchObject({ committed: true });
		expect(expectOk(await parallel)).toMatchObject({ committed: false, reason: "parallel-done" });

		const failureEntered = deferred();
		const failureRelease = deferred();
		const failure = opened.filesystem.mutations.run(same, { createParents: false }, async () => {
			failureEntered.resolve();
			await failureRelease.promise;
			throw new Error("transform failed");
		});
		await failureEntered.promise;
		const afterFailure = commitBytes(opened, same, bytes("recovered"), { createParents: false });
		failureRelease.resolve();
		await expect(failure).rejects.toThrow("transform failed");
		expect(expectOk(await afterFailure)).toMatchObject({
			committed: true,
			receipt: { hash: contentHash(bytes("recovered")) },
		});
	});
	it("cancels queued work with its lease without blocking later mutations", async () => {
		const controller = new AbortController();
		const mutation = await openMutation("queued.txt", { signal: controller.signal });
		const activeEntered = deferred();
		const activeRelease = deferred();
		const active = mutation.run({ createParents: false }, async () => {
			activeEntered.resolve();
			await activeRelease.promise;
			return { type: "reject", reason: "released" };
		});
		await activeEntered.promise;

		const cancelled = mutation.commit(bytes("cancelled"), { createParents: false });
		controller.abort();
		await expect(cancelled).resolves.toMatchObject({ ok: false, error: { code: "aborted" } });
		activeRelease.resolve();
		expect(expectOk(await active)).toMatchObject({ committed: false });
		const laterMutation = await openMutation("queued.txt");
		const later = laterMutation.commit(bytes("later"), { createParents: false });
		expect(expectOk(await later)).toMatchObject({
			committed: true,
			receipt: { hash: contentHash(bytes("later")) },
		});
	});
	it.skipIf(process.platform === "win32")("rechecks a queued target after it becomes a blocked symlink", async () => {
		const protectedDirectory = path.join(test.root, "protected");
		const protectedFile = path.join(protectedDirectory, "secret.txt");
		await mkdir(protectedDirectory);
		await writeFile(protectedFile, "secret");
		const mutation = await openMutation("queued.txt", { initial: "safe", blockedPaths: [`${protectedDirectory}/`] });
		const entered = deferred();
		const release = deferred();
		const active = mutation.run({ createParents: false }, async () => {
			entered.resolve();
			await release.promise;
			return { type: "reject", reason: "no-op" };
		});
		await entered.promise;
		const queued = mutation.commit(bytes("unsafe"), { createParents: false });
		await rm(path.join(workspace, "queued.txt"));
		await symlink(protectedFile, path.join(workspace, "queued.txt"));
		release.resolve();
		expect(expectOk(await active)).toMatchObject({ committed: false });
		await expect(queued).resolves.toMatchObject({ ok: false, error: { code: "blocked" } });
		expect(await readFile(protectedFile, "utf8")).toBe("secret");
	});
	it.skipIf(process.platform === "win32")("serializes stale refs that freshly converge on one canonical target", async () => {
		const one = path.join(workspace, "one-key.txt");
		const two = path.join(workspace, "two-key.txt");
		const shared = path.join(workspace, "shared-key.txt");
		const firstLink = path.join(workspace, "first-key.txt");
		const secondLink = path.join(workspace, "second-key.txt");
		await writeFile(one, "one");
		await writeFile(two, "two");
		await writeFile(shared, "shared");
		await symlink(one, firstLink);
		await symlink(two, secondLink);
		const opened = await openRuntime();
		const first = await resolveTarget(opened, "first-key.txt");
		const second = await resolveTarget(opened, "second-key.txt");
		await rm(firstLink);
		await rm(secondLink);
		await symlink(shared, firstLink);
		await symlink(shared, secondLink);
		let active = 0;
		let maxActive = 0;
		const transform = async () => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise<void>((resolve) => setImmediate(resolve));
			active -= 1;
			return { type: "commit" as const, bytes: bytes("updated") };
		};
		const results = await Promise.all([
			opened.filesystem.mutations.run(first, { createParents: false }, transform),
			opened.filesystem.mutations.run(second, { createParents: false }, transform),
		]);
		for (const result of results) expect(expectOk(result)).toMatchObject({ committed: true });
		expect(maxActive).toBe(1);
		expect(await readFile(shared, "utf8")).toBe("updated");
	});
	it("runs the commit observer before the target queue admits the next transform", async () => {
		const events: string[] = [];
		const runtime = track(new FileSystemRuntime());
		const opened = expectOk(await runtime.open({
			cwd: workspace,
			policy: policy(),
			onCommitted() { events.push("observed"); },
		}));
		const target = await resolveTarget(opened, "observer-order.txt");
		const entered = deferred();
		const release = deferred();
		const first = opened.filesystem.mutations.run(target, { createParents: false }, async () => {
			events.push("first-transform");
			entered.resolve();
			await release.promise;
			return { type: "commit", bytes: bytes("first") };
		});
		await entered.promise;
		const second = opened.filesystem.mutations.run(target, { createParents: false }, () => {
			events.push("second-transform");
			return { type: "commit", bytes: bytes("second") };
		});
		release.resolve();
		expect(expectOk(await first)).toMatchObject({ committed: true });
		expect(expectOk(await second)).toMatchObject({ committed: true });
		expect(events).toEqual(["first-transform", "observed", "second-transform", "observed"]);
	});
	it("aborts queued calls during idempotent runtime and workspace disposal", async () => {
		const runtime = track(new FileSystemRuntime());
		const opened = expectOk(await runtime.open({ cwd: workspace, policy: policy() }));
		const target = await resolveTarget(opened, "dispose.txt");
		const entered = deferred();
		const release = deferred();
		const active = opened.filesystem.mutations.run(target, { createParents: false }, async () => {
			entered.resolve();
			await release.promise;
			return { type: "commit", bytes: bytes("active") };
		});
		await entered.promise;
		const queued = commitBytes(opened, target, bytes("queued"), { createParents: false });
		runtime.dispose();
		runtime.dispose();
		await expect(queued).resolves.toMatchObject({ ok: false, error: { code: "aborted" } });
		release.resolve();
		await expect(active).resolves.toMatchObject({ ok: false, error: { code: "aborted" } });
		expect(opened.disposed).toBe(true);
		opened.dispose();
		await expect(runtime.open({ cwd: workspace, policy: policy() })).resolves.toMatchObject({
			ok: false,
			error: { code: "aborted" },
		});
	});
});
