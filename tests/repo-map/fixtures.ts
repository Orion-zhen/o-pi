import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { defaultFileToolsConfig } from "../../src/file-tools/config.js";
import { createIgnoreSnapshot, defaultIgnoreEngine } from "../../src/file-tools/ignore/ignore-engine.js";
import { REPO_MAP_SESSION_ENTRY } from "../../src/repo-map/activation.js";
import { defaultRepoMapConfig } from "../../src/repo-map/config.js";
import { readActivatedRepoMap, type RepoMapServiceDependencies } from "../../src/repo-map/service.js";
import type { RepoMapGeneration } from "../../src/repo-map/storage.js";
import type { RepoMapFileRecord, RepoMapMetadata } from "../../src/repo-map/types.js";

export async function configureFileTools(configRoot: string, limits: Readonly<Record<string, number>>): Promise<void> {
	const configPath = path.join(configRoot, "file-tools.jsonc");
	await writeFile(configPath, JSON.stringify({
		blocked_path: [".git/"],
		ignored_path: [],
		ignore: { builtin_profile: "none", gitignore: false },
		limits,
	}));
	process.env.PI_FILE_TOOLS_CONFIG = configPath;
}

export function fileRecord(filePath: string, text: string): RepoMapFileRecord {
	return {
		id: `file:${filePath}`,
		path: filePath,
		size: Buffer.byteLength(text),
		mtimeMs: 1,
		status: "indexed",
		contentHash: createHash("sha256").update(text).digest("hex"),
	};
}

export async function writeSources(root: string, sources: ReadonlyMap<string, string>): Promise<void> {
	for (const [filePath, source] of sources) {
		const absolutePath = path.join(root, ...filePath.split("/"));
		await mkdir(path.dirname(absolutePath), { recursive: true });
		await writeFile(absolutePath, source);
	}
}

export function activationEntry(metadata: Pick<RepoMapMetadata, "repositoryRoot" | "mapId" | "generation" | "updatedAt">): SessionEntry {
	return {
		type: "custom",
		id: `activation-${metadata.generation[0]}`,
		parentId: null,
		timestamp: metadata.updatedAt,
		customType: REPO_MAP_SESSION_ENTRY,
		data: {
			kind: "activation",
			root: metadata.repositoryRoot,
			mapId: metadata.mapId,
			generation: metadata.generation,
			activatedAt: metadata.updatedAt,
		},
	};
}

export function serviceDependencies(
	root: string,
	cacheRoot: string,
	now = new Date("2026-07-18T00:00:00.000Z"),
): Partial<RepoMapServiceDependencies> {
	return {
		async detectRepository() {
			return {
				repositoryRoot: root,
				worktreeRoot: root,
				gitCommonDir: path.join(root, ".git"),
				headRevision: "a".repeat(40),
			};
		},
		async readHeadRevision() { return "a".repeat(40); },
		async loadRepoMapConfig() { return defaultRepoMapConfig(); },
		async loadFileToolsConfig() { return defaultFileToolsConfig(); },
		async createIgnoreSnapshot(scanRoot, config) {
			defaultIgnoreEngine.invalidate();
			return await createIgnoreSnapshot(scanRoot, config);
		},
		cacheRoot: () => cacheRoot,
		now: () => now,
	};
}

export async function readGeneration(
	root: string,
	cacheRoot: string,
	mapId: string,
	generation: string,
): Promise<RepoMapGeneration> {
	const value = await readActivatedRepoMap({ root, mapId, generation }, cacheRoot);
	if (value === undefined) throw new Error("missing generation");
	return value;
}
