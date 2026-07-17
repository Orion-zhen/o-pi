import { createHash } from "node:crypto";

import type { RepositoryIdentity } from "./repository.js";

export const REPO_MAP_SCHEMA_VERSION = 2;

export function createRepoMapId(identity: Pick<RepositoryIdentity, "worktreeRoot" | "gitCommonDir">): string {
	const fields: Array<readonly [string, string]> = [
		["schema-major", String(REPO_MAP_SCHEMA_VERSION)],
		["worktree-root", stablePath(identity.worktreeRoot)],
		["git-common-dir", stablePath(identity.gitCommonDir)],
	];
	const hash = createHash("sha256");
	for (const [label, value] of fields) hash.update(`${label.length}:${label}${value.length}:${value}`);
	return hash.digest("hex");
}

function stablePath(value: string): string {
	return value.replace(/\\/gu, "/");
}
