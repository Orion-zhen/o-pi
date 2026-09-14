import { readFile } from "../../src/harness/file-tools/read/command.ts";
import type { InlineImageProcessor, PdfDocumentSource, ReadStructureSource } from "../../src/harness/file-tools/read/ports.ts";
import type { ReadFileSuccess, ReadParams } from "../../src/harness/file-tools/read/types.ts";
import { FileToolsHost } from "../../src/harness/file-tools/runtime/host.ts";
import type { ToolOutcome } from "../../src/harness/file-tools/shared/result.ts";
import { createInlineImageProcessor } from "../../src/harness/file-tools/pi/ports/read-image.ts";
import { createPdfDocumentSource } from "../../src/harness/file-tools/pi/ports/read-pdf.ts";

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
