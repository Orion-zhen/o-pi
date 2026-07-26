import path from "node:path";

import { loadFileToolsConfig } from "../file-tools-config/config.js";
import { FileSystemRuntime } from "../filesystem/runtime.js";
import { RepoMapError } from "./errors.js";

/** Determines whether a live repository path belongs to the current automatic index scope. */
export async function isRepoMapPathInScope(root: string, requestedPath: string): Promise<boolean> {
	if (relativeRepoPath(root, requestedPath) === undefined) return false;
	const config = await loadFileToolsConfig(root);
	if (!config.ok) throw new RepoMapError("CONFIG_ERROR", config.error.message, config.error.details);
	const runtime = new FileSystemRuntime();
	try {
		const opened = await runtime.open({ cwd: root, policy: config.value.filesystem });
		if (!opened.ok) {
			if (opened.error.code === "aborted") throw new RepoMapError("OPERATION_ABORTED", opened.error.message, opened.error);
			return false;
		}
		try {
			const resolved = await opened.value.filesystem.paths.resolveExisting(
				requestedPath,
				{ expected: "file", followFinalSymlink: true },
				opened.value.context,
			);
			if (!resolved.ok || resolved.value.kind !== "file") return false;
			const visibility = await opened.value.filesystem.visibility.evaluate(resolved.value, "index", opened.value.context);
			return visibility.ok && !visibility.value.ignored;
		} finally {
			opened.value.dispose();
		}
	} finally {
		runtime.dispose();
	}
}

export function relativeRepoPath(root: string, requestedPath: string): string | undefined {
	const relative = path.relative(path.resolve(root), path.resolve(requestedPath));
	if (relative === "") return undefined;
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
	return relative.replaceAll(path.sep, "/");
}
