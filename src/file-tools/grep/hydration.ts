import pLimit from "p-limit";

import type { FsOperationContext } from "../../filesystem/contracts/result.js";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.js";
import { fail, type ToolOutcome } from "../shared/result.js";
import type { GrepScopedFile } from "./indexer.js";

const SOURCE_READ_CONCURRENCY = 8;

export interface GrepHydrationContext {
	readonly filesystem: WorkspaceFileSystem;
	readonly operation: FsOperationContext;
	readonly maxFileBytes: number;
}

/** Hydrates only traversal-approved paths and revalidates kind, metadata, size, text, and hash live. */
export async function hydrateGrepSourceText(
	sourceText: Map<string, string>,
	sourceHashes: Map<string, string>,
	filesByPath: ReadonlyMap<string, GrepScopedFile>,
	paths: readonly string[],
	context: GrepHydrationContext,
): Promise<ToolOutcome<Map<string, string>>> {
	const candidates = paths.filter((filePath) => !sourceText.has(filePath) && filesByPath.has(filePath));
	const limit = pLimit(SOURCE_READ_CONCURRENCY);
	const loaded = await Promise.all(candidates.map((filePath) => limit(async () => {
		if (isAborted(context.operation.signal)) return { filePath, failure: aborted(filePath) } as const;
		const expected = filesByPath.get(filePath);
		if (expected === undefined) return { filePath } as const;
		const resolved = await context.filesystem.paths.resolveExisting(filePath, { expected: "file", followFinalSymlink: false }, context.operation);
		if (!resolved.ok || resolved.value.kind !== "file") return { filePath } as const;
		const metadata = await context.filesystem.metadata.stat(resolved.value, context.operation);
		if (!metadata.ok) return metadata.error.code === "aborted" ? { filePath, failure: aborted(filePath) } as const : { filePath } as const;
		const version = metadata.value.version ?? `${metadata.value.sizeBytes}:${metadata.value.modifiedAtMs}`;
		if (version !== expected.metadataVersion || metadata.value.sizeBytes > context.maxFileBytes) return { filePath } as const;
		const content = await context.filesystem.content.readText(
			resolved.value,
			{ maxBytes: context.maxFileBytes, stable: true, rejectBinary: true },
			context.operation,
		);
		if (!content.ok) return content.error.code === "aborted" ? { filePath, failure: aborted(filePath) } as const : { filePath } as const;
		return { filePath, text: content.value.text, hash: content.value.hash } as const;
	})));
	for (const item of loaded) {
		if ("failure" in item) return item.failure;
		if (!("text" in item) || typeof item.text !== "string" || typeof item.hash !== "string") continue;
		sourceText.set(item.filePath, item.text);
		sourceHashes.set(item.filePath, item.hash);
	}
	return sourceText;
}

function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

function aborted(path: string): ReturnType<typeof fail> {
	return fail("OPERATION_ABORTED", "grep was aborted.", { path });
}
