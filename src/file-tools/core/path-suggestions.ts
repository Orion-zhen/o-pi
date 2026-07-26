import { createWorkspaceNamespace } from "../../filesystem/kernel/namespace.js";
import { NodeNativeFileSystem } from "../../filesystem/platform/node/native-filesystem.js";
import { createReadonlyFileSystemServices } from "../../filesystem/services/readonly.js";
import { createVisibilityPolicy } from "../../filesystem/services/visibility/policy.js";
import { WorkspaceVisibilityService } from "../../filesystem/services/visibility/service.js";
import type { FileToolsConfig } from "../config.js";

/** Repo-map query surface for path suggestions — minimal interface to avoid coupling. */
export interface PathSuggestionQuery {
	query(input: { requestedPath: string; query: string; limit: number }): Promise<{
		candidates: readonly { path: string; score: number; hop: 0 | 1 | 2 }[];
	} | undefined>;
}

/** Returns visible workspace file suggestions; enhancement and filesystem failures safely degrade. */
export async function findPathSuggestions(
	workspaceRoot: string,
	inputPath: string,
	config: FileToolsConfig | undefined,
	repoMap: PathSuggestionQuery | undefined,
	maxEntries = 10_000,
	limit = 3,
): Promise<string[]> {
	if (repoMap !== undefined) {
		try {
			const result = await repoMap.query({ requestedPath: workspaceRoot, query: inputPath, limit });
			if (result !== undefined) {
				const paths = result.candidates
					.filter((candidate) => candidate.hop === 0)
					.slice(0, limit)
					.map((candidate) => candidate.path);
				if (paths.length > 0) return paths;
			}
		} catch {
			// Repo Map is a best-effort source; the filesystem catalog remains authoritative.
		}
	}

	try {
		const native = new NodeNativeFileSystem();
		const namespace = await createWorkspaceNamespace({
			workspaceRoot,
			blockedPaths: config?.filesystem.blockedPaths ?? [".git/"],
			native,
		});
		if (!namespace.ok) return [];
		const policy = config?.filesystem.visibility ?? createVisibilityPolicy({
			ignoredPaths: [".git/"],
			ignore: { builtinProfile: "none" },
		});
		const visibilitySnapshot = await new WorkspaceVisibilityService(native).createSnapshot(workspaceRoot, policy);
		const services = createReadonlyFileSystemServices({ native, namespace: namespace.value, visibilitySnapshot });
		const suggestions = await services.catalog.suggest(namespace.value.root, inputPath, { limit, maxEntries }, {});
		if (!suggestions.ok) return [];
		return suggestions.value.map((candidate) => candidate.ref.workspacePath ?? candidate.ref.displayPath);
	} catch {
		return [];
	}
}
