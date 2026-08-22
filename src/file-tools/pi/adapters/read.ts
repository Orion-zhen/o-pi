import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { readFile } from "../../read/command.js";
import { isReadImageSuccess, isReadSuccess } from "../../read/guards.js";
import type { InlineImageProcessor } from "../../read/ports.js";
import { formatReadModelResult } from "../../read/presenter.js";
import type { ReadFileSuccess, ReadOutputFormat, ReadParams } from "../../read/types.js";
import type { FileToolsHost } from "../../runtime/host.js";
import { fail, isFailed, type FailedResult } from "../../shared/result.js";
import type { LspFileOperations } from "../../../lsp/file-hooks.js";
import {
	resolveReadLocator,
	type SkillReadIndex,
	type SkillResourceError,
} from "../../../skill-context/resources.js";
import { formatErrorModelResult } from "../model-output.js";
import {
	createReadObservationStore,
	createReadStructureSource,
} from "../ports/read.js";

export interface ExecuteReadOptions {
	readonly cwd: string;
	readonly sessionId: string;
	readonly signal?: AbortSignal;
	readonly model: { api?: string; input?: readonly string[] } | undefined;
	readonly host: FileToolsHost;
	readonly lsp: LspFileOperations;
	readonly branch: SessionEntry[];
	readonly skillIndex: SkillReadIndex;
}

export async function executeRead(params: ReadParams, options: ExecuteReadOptions) {
	const supportedOutputFormats = readOutputFormats(options.model?.api);
	const resolution = await resolveReadLocator(params.path, options.branch, options.skillIndex);
	if (resolution.kind === "error") return failedResult(mapSkillError(resolution));
	const skill = resolution.kind === "skill" ? resolution : undefined;

	const opened = await options.host.open({
		cwd: options.cwd,
		sessionId: options.sessionId,
		...(options.signal === undefined ? {} : { signal: options.signal }),
	});
	if (isFailed(opened)) return failedResult(opened);
	try {
		const observation = createReadObservationStore(opened);
		const result = await readFile(
			{ ...params, ...(skill === undefined ? {} : { path: skill.filePath }) },
			{
				filesystem: opened.filesystem,
				operation: opened.context,
				observation,
				limits: {
					bytes: opened.limits.read_bytes,
					fileBytes: opened.limits.read_max_file_bytes,
					lines: opened.limits.read_lines,
					suggestions: opened.limits.read_suggestion_limit,
				},
				image: lazyInlineImageProcessor,
				supportedOutputFormats,
				...(skill === undefined
					? {
							structure: createReadStructureSource(opened, options.lsp),
						}
					: { recordObservation: false }),
			},
		);
		if (skill !== undefined) applySkillResolution(result, skill);
		return presentResult(result, options.model);
	} finally {
		opened.dispose();
	}
}

function readOutputFormats(api: string | undefined): readonly ReadOutputFormat[] {
	return api === "openai-completions" ? ["text"] : ["text", "image"];
}

const lazyInlineImageProcessor: InlineImageProcessor = {
	async process(input) {
		const { createInlineImageProcessor } = await import("../ports/read-image.js");
		return await createInlineImageProcessor().process(input);
	},
};

function presentResult(
	result: ReadFileSuccess | FailedResult,
	model: { input?: readonly string[] } | undefined,
) {
	if (isFailed(result)) return failedResult(result);
	if ("media_type" in result) {
		return { content: formatReadImageModelContent(result, model), details: result };
	}
	return { content: [{ type: "text" as const, text: formatReadModelResult(result) }], details: result };
}

function formatReadImageModelContent(
	result: Extract<ReadFileSuccess, { media_type: "image" }>,
	model: { input?: readonly string[] } | undefined,
): Array<TextContent | ImageContent> {
	const nonVisionNote = model === undefined || model.input?.includes("image")
		? undefined
		: "[Current model does not support images. The image may be omitted by the provider.]";
	const note = [result.content, nonVisionNote].filter((part): part is string => part !== undefined).join("\n");
	return [
		{ type: "text", text: note },
		{ type: "image", data: result.image.data, mimeType: result.image.mime_type },
	];
}

function applySkillResolution(
	result: ReadFileSuccess | FailedResult,
	skill: Extract<Awaited<ReturnType<typeof resolveReadLocator>>, { kind: "skill" }>,
): void {
	if (isReadSuccess(result) || isReadImageSuccess(result)) {
		result.path = skill.logicalPath;
		result.skill_resource = { skill: skill.skillName, path: skill.relativePath };
	} else if (result.error.path !== undefined) result.error.path = skill.logicalPath;
}

function mapSkillError(error: SkillResourceError): FailedResult {
	return fail(error.code === "invalid-locator" ? "INVALID_PATH" : "PROTECTED_PATH", error.message, { path: error.path });
}

function failedResult(result: FailedResult) {
	return { content: [{ type: "text" as const, text: formatErrorModelResult(result) }], details: result };
}
