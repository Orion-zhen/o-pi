import { readFile } from "../../src/file-tools/read/command.js";
import type {
	InlineImageProcessor,
	MissingPathSource,
	ReadGraphContextSource,
	ReadStructureSource,
} from "../../src/file-tools/read/ports.js";
import type { ReadFileSuccess, ReadParams } from "../../src/file-tools/read/types.js";
import { FileToolsHost, type FileToolsInvocation } from "../../src/file-tools/runtime/host.js";
import type { ToolOutcome } from "../../src/file-tools/shared/result.js";
import { createInlineImageProcessor } from "../../src/file-tools/pi/ports/read-image.js";
import type { RepoMapFileToolQuery, RepoMapReadContext } from "../../src/repo-map/file-tool-query.js";
import { formatRepoMapReadContext } from "../../src/repo-map/tool-output.js";

export interface ReadWorkspaceTestOptions {
	readonly host?: FileToolsHost;
	readonly sessionId?: string;
	readonly missingPaths?: MissingPathSource;
	readonly structure?: ReadStructureSource;
	readonly graph?: ReadGraphContextSource;
	readonly repoMap?: Pick<RepoMapFileToolQuery, "readContext">;
	formatRepoMapContext?(context: RepoMapReadContext): Promise<string | undefined>;
	readonly image?: InlineImageProcessor;
	readonly signal?: AbortSignal;
	readonly recordObservation?: boolean;
}

export async function readWorkspaceFile(
	cwd: string,
	params: ReadParams,
	options: ReadWorkspaceTestOptions = {},
): Promise<ToolOutcome<ReadFileSuccess>> {
	const host = options.host ?? new FileToolsHost();
	const ownsHost = options.host === undefined;
	try {
		const opened = await host.open({ cwd, sessionId: options.sessionId ?? "test-read", ...(options.signal === undefined ? {} : { signal: options.signal }) });
		if ("status" in opened) return opened;
		try {
			const graph = graphSource(options, opened);
			return await readFile(params, {
				filesystem: opened.filesystem,
				operation: opened.context,
				observation: opened.observation,
				limits: {
					bytes: opened.limits.read_bytes,
					fileBytes: opened.limits.read_max_file_bytes,
					lines: opened.limits.read_lines,
					suggestions: opened.limits.read_suggestion_limit,
				},
				image: options.image ?? createInlineImageProcessor(),
				...(options.missingPaths === undefined ? {} : { missingPaths: options.missingPaths }),
				...(options.structure === undefined ? {} : { structure: options.structure }),
				...(graph === undefined ? {} : { graph }),
				...(options.recordObservation === undefined ? {} : { recordObservation: options.recordObservation }),
			});
		} finally {
			opened.dispose();
		}
	} finally {
		if (ownsHost) host.dispose();
	}
}

function graphSource(options: ReadWorkspaceTestOptions, opened: FileToolsInvocation): ReadGraphContextSource | undefined {
	if (options.graph !== undefined) return options.graph;
	if (options.repoMap === undefined) return undefined;
	return {
		async context(input) {
			const identity = opened.nativeBridge.getNativeIdentity(input.file);
			if (identity === undefined) return undefined;
			const context = await options.repoMap?.readContext({
				requestedPath: identity.canonicalPath,
				contentHash: input.version.hash.replace(/^sha256:/u, ""),
				startLine: input.startLine,
				endLine: input.endLine,
				partial: input.partial,
				truncated: input.truncated,
			});
			if (context === undefined) return undefined;
			const rendered = options.formatRepoMapContext === undefined
				? formatRepoMapReadContext(context)
				: await options.formatRepoMapContext(context);
			return rendered === undefined ? undefined : { context, rendered };
		},
	};
}
