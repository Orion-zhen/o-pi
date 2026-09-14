import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { readFile } from "../../read/command.js";
import type { InlineImageProcessor, PdfDocumentSource } from "../../read/ports.js";
import { formatReadModelResult, formatReadPdfModelSummary, formatReadPdfPageMarker } from "../../read/presenter.js";
import type { ReadFileSuccess, ReadParams } from "../../read/types.js";
import { isFailed, type FailedResult } from "../../shared/result.js";
import type { LoadLsp } from "../../../lsp/file-operations.js";
import { parseSkillPath, type SkillPath } from "../../../skill-context/resources.js";
import { failedToolResult, withFileToolsInvocation, type FileToolRuntime } from "../invocation.js";
import { bindFileLsp } from "../lsp.js";

export interface ExecuteReadOptions extends FileToolRuntime {
	readonly model: { input?: readonly string[] } | undefined;
	readonly lsp: LoadLsp;
}

export async function executeRead(params: ReadParams, options: ExecuteReadOptions) {
	const skill = params.path.startsWith("skill://") ? parseSkillPath(params.path) : undefined;
	return withFileToolsInvocation<ReadFileSuccess | FailedResult>(options, async (opened) => {
		const result = await readFile(
			params,
			{
				...opened,
				image: lazyInlineImageProcessor,
				pdf: lazyPdfDocumentSource,
				structure: bindFileLsp(opened, options.lsp).structure,
			},
		);
		if (skill?.kind === "skill") applySkillResolution(result, skill);
		return presentResult(result, options.model);
	});
}

const lazyInlineImageProcessor: InlineImageProcessor = {
	async process(input) {
		const { createInlineImageProcessor } = await import("../ports/read-image.js");
		return await createInlineImageProcessor().process(input);
	},
};

const lazyPdfDocumentSource: PdfDocumentSource = {
	async open(input) {
		const { createPdfDocumentSource } = await import("../ports/read-pdf.js");
		return await createPdfDocumentSource().open(input);
	},
};

function presentResult(
	result: ReadFileSuccess | FailedResult,
	model: { input?: readonly string[] } | undefined,
) {
	if (isFailed(result)) return failedToolResult(result);
	if (!("media_type" in result)) {
		return { content: [{ type: "text" as const, text: formatReadModelResult(result) }], details: result };
	}
	return result.media_type === "image"
		? { content: formatReadImageModelContent(result, model), details: result }
		: { content: formatReadPdfModelContent(result, model), details: result };
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

function formatReadPdfModelContent(
	result: Extract<ReadFileSuccess, { media_type: "pdf" }>,
	model: { input?: readonly string[] } | undefined,
): Array<TextContent | ImageContent> {
	const nonVisionNote = model === undefined || model.input?.includes("image")
		? undefined
		: "[Current model does not support images. PDF page images may be omitted by the provider.]";
	const summary = formatReadPdfModelSummary(result);
	const content: Array<TextContent | ImageContent> = [
		{ type: "text", text: nonVisionNote === undefined ? summary : `${summary}\n${nonVisionNote}` },
	];
	for (const page of result.pages) {
		content.push(
			{ type: "text", text: formatReadPdfPageMarker(page) },
			{ type: "image", data: page.image.data, mimeType: page.image.mime_type },
		);
	}
	return content;
}

function applySkillResolution(
	result: ReadFileSuccess | FailedResult,
	skill: SkillPath,
): void {
	if (isFailed(result)) {
		if (result.error.path !== undefined) result.error.path = skill.logicalPath;
		return;
	}
	result.path = skill.logicalPath;
	result.skill_resource = { skill: skill.skillName, path: skill.relativePath };
}
