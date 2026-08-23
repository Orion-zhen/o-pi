import { readFile } from "../../src/file-tools/read/command.js";
import type { InlineImageProcessor, PdfDocumentSource, ReadStructureSource } from "../../src/file-tools/read/ports.js";
import type { ReadFileSuccess, ReadOutputFormat, ReadParams } from "../../src/file-tools/read/types.js";
import { FileToolsHost } from "../../src/file-tools/runtime/host.js";
import type { ToolOutcome } from "../../src/file-tools/shared/result.js";
import { createInlineImageProcessor } from "../../src/file-tools/pi/ports/read-image.js";
import { createPdfDocumentSource } from "../../src/file-tools/pi/ports/read-pdf.js";

export interface ReadWorkspaceTestOptions {
	readonly host?: FileToolsHost;
	readonly sessionId?: string;
	readonly structure?: ReadStructureSource;
	readonly image?: InlineImageProcessor;
	readonly pdf?: PdfDocumentSource;
	readonly supportedOutputFormats?: readonly ReadOutputFormat[];
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
			return await readFile(params, {
				filesystem: opened.filesystem,
				operation: opened.context,
				observation: opened.observation,
				limits: {
					bytes: opened.limits.read_bytes,
					fileBytes: opened.limits.read_max_file_bytes,
					lines: opened.limits.read_lines,
					pdfPages: opened.limits.read_pdf_pages,
					suggestions: opened.limits.read_suggestion_limit,
				},
				image: options.image ?? createInlineImageProcessor(),
				pdf: options.pdf ?? createPdfDocumentSource(),
				...(options.supportedOutputFormats === undefined ? {} : { supportedOutputFormats: options.supportedOutputFormats }),
				...(options.structure === undefined ? {} : { structure: options.structure }),
				...(options.recordObservation === undefined ? {} : { recordObservation: options.recordObservation }),
			});
		} finally {
			opened.dispose();
		}
	} finally {
		if (ownsHost) host.dispose();
	}
}
