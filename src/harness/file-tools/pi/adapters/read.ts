import { readFile } from "../../read/command.ts";
import type { InlineImageProcessor } from "../../read/ports.ts";
import type { PdfDocumentSource } from "../../../media/pdf-types.ts";
import { formatReadModelResult, formatReadPdfModelSummary, formatReadPdfPageMarker } from "../../read/presenter.ts";
import type { ReadFileSuccess, ReadParams } from "../../read/types.ts";
import { isFailed, type FailedResult } from "../../shared/result.ts";
import type { LoadLsp } from "../../../lsp/file-operations.ts";
import { parseSkillPath, type SkillPath } from "../../../skill-context/resources.ts";
import { failedToolResult, withFileToolsInvocation, type FileToolRuntime } from "../invocation.ts";
import { createReadStructureSource } from "../ports/read-structure.ts";

export async function executeRead(params: ReadParams, options: FileToolRuntime & { lsp: LoadLsp }) {
	const skill = params.path.startsWith("skill://") ? parseSkillPath(params.path) : undefined;
	return withFileToolsInvocation<ReadFileSuccess | FailedResult>(options, async (opened) => {
		const result = await readFile(
			params,
			{
				...opened,
				image: lazyInlineImageProcessor,
				pdf: lazyPdfDocumentSource,
				structure: createReadStructureSource(opened, options.lsp),
			},
		);
		if (skill?.kind === "skill") applySkillResolution(result, skill);
		return presentResult(result);
	});
}

const lazyInlineImageProcessor: InlineImageProcessor = {
	async process(input) {
		const { createInlineImageProcessor } = await import("../ports/read-image.ts");
		return await createInlineImageProcessor().process(input);
	},
};

const lazyPdfDocumentSource: PdfDocumentSource = {
	async open(input) {
		const { createPdfDocumentSource } = await import("../../../media/pdf.ts");
		return await createPdfDocumentSource().open(input);
	},
};

function presentResult(result: ReadFileSuccess | FailedResult) {
	if (isFailed(result)) return failedToolResult(result);
	if (!("media_type" in result)) {
		const text = formatReadModelResult(result);
		return { content: [{ type: "text" as const, text }], structuredContent: text, details: result };
	}
	if (result.media_type === "image") {
		const { data, mime_type: mimeType } = result.image;
		const image = { type: "image" as const, data, mimeType };
		return {
			content: [{ type: "text" as const, text: result.content }, image], details: result,
			structuredContent: { ...image, note: result.content },
		};
	}
	const content = [
		{ type: "text" as const, text: formatReadPdfModelSummary(result) },
		...result.pages.flatMap((page) => [
			{ type: "text" as const, text: formatReadPdfPageMarker(page) },
			{ type: "image" as const, data: page.image.data, mimeType: page.image.mime_type },
		]),
	];
	return { content, details: result, structuredContent: { type: "pdf" as const, content } };
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
