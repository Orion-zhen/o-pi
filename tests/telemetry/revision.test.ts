import { readFile, stat, utimes } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { captureGitRevision } from "../../src/telemetry/revision.js";
import { initializeGitRepository } from "../helpers/git.js";
import { useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-telemetry-revision-");

describe("telemetry git revision", () => {
	it("采集版本信息不刷新 index 或创建 optional lock", async () => {
		const trackedFile = await initializeGitRepository(temp.path);
		const indexPath = path.join(temp.path, ".git", "index");
		const lockPath = `${indexPath}.lock`;
		const before = await readFile(indexPath);
		const future = new Date(Date.now() + 60_000);
		await utimes(trackedFile, future, future);

		await expect(captureGitRevision(temp.path)).resolves.toMatchObject({
			root: temp.path,
			dirty: false,
			commit: expect.stringMatching(/^[0-9a-f]{40,64}$/u),
		});

		expect(await readFile(indexPath)).toEqual(before);
		await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
