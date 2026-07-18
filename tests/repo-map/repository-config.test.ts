import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { defaultRepoMapConfig, loadRepoMapConfig, repoMapCacheRoot, repoMapConfigFingerprint } from "../../src/repo-map/config.js";
import { isActivatedGenerationCurrent } from "../../src/repo-map/current-pointer.js";
import { RepoMapError } from "../../src/repo-map/errors.js";
import { createRepoMapId } from "../../src/repo-map/identity.js";
import { detectRepository, type GitRunner } from "../../src/repo-map/repository.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-repo-foundation-");
preserveEnv("HOME", "PI_REPO_MAP_CONFIG", "PI_REPO_MAP_CACHE_DIR");

describe("Repo Map repository and identity", () => {
	it("canonicalizes a repository child and permits an unborn HEAD", async () => {
		const root = path.join(temp.path, "repo");
		const child = path.join(root, "src");
		const common = path.join(root, ".git");
		await mkdir(child, { recursive: true });
		await mkdir(common);
		const calls: string[][] = [];
		const runGit: GitRunner = async (_cwd, args) => {
			calls.push(args);
			if (args.includes("--verify")) throw new Error("unborn");
			return { stdout: `false\n${root}\n${common}\n` };
		};
		const identity = await detectRepository(child, { runGit });
		expect(identity).toEqual({ repositoryRoot: root, worktreeRoot: root, gitCommonDir: common });
		expect(calls).toHaveLength(2);
	});

	it.each([
		["non-worktree", Object.assign(new Error("not a repository"), { code: 128 }), "NOT_GIT_WORKTREE"],
		["missing git", Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }), "GIT_UNAVAILABLE"],
	] as const)("reports %s with a stable error code", async (_label, failure, code) => {
		const runGit: GitRunner = async () => { throw failure; };
		await expect(detectRepository(temp.path, { runGit })).rejects.toMatchObject({ code });
	});

	it("rejects bare repositories", async () => {
		const runGit: GitRunner = async () => ({ stdout: `true\n${temp.path}\n${temp.path}\n` });
		await expect(detectRepository(temp.path, { runGit })).rejects.toMatchObject({ code: "NOT_GIT_WORKTREE" });
	});

	it("uses worktree and common-dir but not HEAD or cwd child in the map ID", () => {
		const identity = { worktreeRoot: "/repo/worktree", gitCommonDir: "/repo/.git" };
		const first = createRepoMapId(identity);
		expect(first).toMatch(/^[0-9a-f]{64}$/u);
		expect(createRepoMapId(identity)).toBe(first);
		expect(createRepoMapId({ ...identity, worktreeRoot: "/repo/other-worktree" })).not.toBe(first);
	});
});

describe("Repo Map config", () => {
	it("将默认缓存放在统一的用户缓存目录", () => {
		process.env.HOME = temp.path;
		delete process.env.PI_REPO_MAP_CACHE_DIR;
		expect(repoMapCacheRoot()).toBe(path.join(temp.path, ".pi", "cache", "repo-map"));
	});

	it("checks only the exact safe CURRENT pointer for lightweight status", async () => {
		const cacheRoot = path.join(temp.path, "pointer-cache");
		const mapId = "a".repeat(64);
		const generation = "b".repeat(64);
		process.env.PI_REPO_MAP_CACHE_DIR = cacheRoot;
		await mkdir(path.join(cacheRoot, mapId), { recursive: true });
		await writeFile(path.join(cacheRoot, mapId, "CURRENT"), `${generation}\n`);
		const activation = { root: "/repo", mapId, generation, activatedAt: "2026-07-18T00:00:00.000Z" };

		expect(await isActivatedGenerationCurrent(activation)).toBe(true);
		expect(await isActivatedGenerationCurrent({ ...activation, generation: "c".repeat(64) })).toBe(false);
		expect(await isActivatedGenerationCurrent({ ...activation, mapId: "../escape" })).toBe(false);
	});

	it("returns isolated defaults and a stable fingerprint when the user file is absent", async () => {
		process.env["PI_REPO_MAP_CONFIG"] = path.join(temp.path, "missing.jsonc");
		const first = await loadRepoMapConfig();
		const second = defaultRepoMapConfig();
		expect(first).toEqual(second);
		expect(repoMapConfigFingerprint(first)).toBe(repoMapConfigFingerprint(second));
		first.scan.concurrency = 1;
		expect(defaultRepoMapConfig().scan.concurrency).toBe(8);
	});

	it("loads JSONC from the environment override and merges defaults", async () => {
		const configPath = path.join(temp.path, "repo-map.jsonc");
		process.env["PI_REPO_MAP_CONFIG"] = configPath;
		await writeFile(configPath, `{ "scan": { "concurrency": 3, }, // comment\n }`);
		expect(await loadRepoMapConfig()).toMatchObject({ scan: { concurrency: 3, max_files: 100_000 }, cache: { max_generations: 2 } });
	});

	it.each([
		[`{ "scan": { "concurrency": 0 } }`, "schema"],
		[`{ "scan":`, "JSONC"],
	] as const)("rejects invalid config (%s)", async (content, message) => {
		const configPath = path.join(temp.path, "bad.jsonc");
		process.env["PI_REPO_MAP_CONFIG"] = configPath;
		await writeFile(configPath, content);
		await expect(loadRepoMapConfig()).rejects.toEqual(expect.objectContaining<Partial<RepoMapError>>({ code: "CONFIG_ERROR", message: expect.stringContaining(message) }));
	});
});
