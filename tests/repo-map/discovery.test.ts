import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { discoverCurrentRepoMap } from "../../src/repo-map/discovery.js";
import { initializeRepoMap } from "../../src/repo-map/service.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

const execFileAsync = promisify(execFile);
const gitAvailable = await hasGit();
const temp = useTempDir("o-pi-repo-discovery-");
preserveEnv("PI_REPO_MAP_CACHE_DIR", "PI_REPO_MAP_CONFIG", "PI_FILE_TOOLS_PROJECT_ROOT");

describe.skipIf(!gitAvailable)("Repo Map automatic discovery", () => {
	it("reads only an existing current map and detects an obsolete HEAD", async () => {
		const root = path.join(temp.path, "repo");
		process.env.PI_REPO_MAP_CACHE_DIR = path.join(temp.path, "cache");
		process.env.PI_REPO_MAP_CONFIG = path.join(temp.path, "repo-map.jsonc");
		process.env.PI_FILE_TOOLS_PROJECT_ROOT = root;
		await mkdir(root);
		await execFileAsync("git", ["init", "--quiet", root]);
		await writeFile(path.join(root, "a.ts"), "export const A = 1;\n");
		await commit(root, "initial");

		expect(await discoverCurrentRepoMap(root)).toBeUndefined();
		const initialized = await initializeRepoMap({ cwd: root });
		expect(await discoverCurrentRepoMap(root)).toMatchObject({
			root,
			mapId: initialized.metadata.mapId,
			generation: initialized.metadata.generation,
			needsRefresh: false,
		});

		await writeFile(path.join(root, "b.ts"), "export const B = 2;\n");
		await commit(root, "next");
		expect(await discoverCurrentRepoMap(root)).toMatchObject({ needsRefresh: true });
	});
});

async function commit(root: string, message: string): Promise<void> {
	await execFileAsync("git", ["-C", root, "add", "."]);
	await execFileAsync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", message]);
}

async function hasGit(): Promise<boolean> {
	try {
		await execFileAsync("git", ["--version"]);
		return true;
	} catch {
		return false;
	}
}
