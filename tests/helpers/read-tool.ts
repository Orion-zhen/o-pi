import { readFile } from "../../src/file-tools/read/command.js";
import type { InlineImageProcessor, PdfDocumentSource, ReadStructureSource } from "../../src/file-tools/read/ports.js";
import type { ReadFileSuccess, ReadParams } from "../../src/file-tools/read/types.js";
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
	readonly signal?: AbortSignal;
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
				...opened,
				image: options.image ?? createInlineImageProcessor(),
				pdf: options.pdf ?? createPdfDocumentSource(),
				...(options.structure === undefined ? {} : { structure: options.structure }),
			});
		} finally {
			opened.dispose();
		}
	} finally {
		if (ownsHost) host.dispose();
	}
}
