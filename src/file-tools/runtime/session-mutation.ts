import type { ContentVersion } from "../../filesystem/contracts/content.js";
import type { FileRef } from "../../filesystem/contracts/path.js";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.js";
import type { FileObservations, ObservationEntry } from "./observation-store.js";

export interface SessionMutationScope {
	finish(): Promise<void>;
	dispose(): void;
}

export interface SessionMutationContext {
	readonly filesystem: WorkspaceFileSystem;
	readonly observation: FileObservations;
	readonly observations: readonly ObservationEntry[];
	readonly maxFileBytes: number;
	dispose(): void;
}

interface VersionProbe {
	readonly file: FileRef;
	readonly version: ContentVersion;
}

/** 捕获一次模型命令的变更窗口，但不采纳命令开始前已经 stale 的文件。 */
export async function createSessionMutationScope(context: SessionMutationContext): Promise<SessionMutationScope> {
	const eligible: ObservationEntry[] = [];
	for (const observation of context.observations) {
		const current = await probeVersion(context, observation.canonicalPath);
		if (current?.version.hash === observation.version.hash) eligible.push(observation);
	}
	return {
		async finish() {
			try {
				for (const observation of eligible) {
					const current = await probeVersion(context, observation.canonicalPath);
					if (current !== undefined) context.observation.remember(current.file, current.version);
				}
			} finally {
				context.dispose();
			}
		},
		dispose() {
			context.dispose();
		},
	};
}

async function probeVersion(context: SessionMutationContext, canonicalPath: string): Promise<VersionProbe | undefined> {
	const resolved = await context.filesystem.paths.resolveExisting(canonicalPath, {
		expected: "file",
		followFinalSymlink: false,
	});
	if (!resolved.ok) return undefined;
	const loaded = await context.filesystem.content.readBytes(resolved.value, { maxBytes: context.maxFileBytes });
	if (!loaded.ok) return undefined;
	return {
		file: resolved.value,
		version: { hash: loaded.value.hash, sizeBytes: loaded.value.sizeBytes },
	};
}
