import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { useTempDir } from "../helpers/lifecycle.js";
import { expectFsOk, openReadonly } from "./fixtures.js";

const temp = useTempDir("o-pi-metadata-fs-");
let workspace: string;

beforeEach(async () => {
	workspace = path.join(temp.path, "workspace");
	await mkdir(workspace);
});

describe("filesystem metadata", () => {
	it.skipIf(process.platform === "win32")("lists and stats guarded entries while preserving symlinks and stable order", async () => {
		await writeFile(path.join(workspace, "b.txt"), "b");
		await writeFile(path.join(workspace, "a.txt"), "a");
		await writeFile(path.join(workspace, "secret.txt"), "secret");
		await symlink("a.txt", path.join(workspace, "link.txt"));
		const opened = await openReadonly(workspace, { blockedPaths: ["secret.txt"] });
		const listed = expectFsOk(await opened.services.metadata.list(opened.namespace.root));
		const file = listed.find((entry) => entry.name === "a.txt")?.ref;
		const link = listed.find((entry) => entry.name === "link.txt")?.ref;
		if (file === undefined || link === undefined) throw new Error("Expected listed refs.");
		expect(expectFsOk(await opened.services.metadata.stat(file))).toMatchObject({ kind: "file", sizeBytes: 1 });
		expect(expectFsOk(await opened.services.metadata.stat(link))).toMatchObject({ kind: "symlink" });
		expect(listed.map((entry) => ({ name: entry.name, kind: entry.ref.kind, target: entry.linkTarget }))).toEqual([
			{ name: "a.txt", kind: "file", target: undefined },
			{ name: "b.txt", kind: "file", target: undefined },
			{ name: "link.txt", kind: "symlink", target: "a.txt" },
		]);
		await rm(path.join(workspace, "a.txt"));
		expect(await opened.services.metadata.stat(file)).toMatchObject({ ok: false, error: { code: "not-found" } });
		const controller = new AbortController();
		const cancelledOpened = await openReadonly(workspace, { ownerSignal: controller.signal });
		controller.abort("stop");
		expect(await cancelledOpened.services.metadata.list(cancelledOpened.namespace.root)).toMatchObject({
			ok: false, error: { code: "aborted" },
		});
	});
});
