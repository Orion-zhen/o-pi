import { findFiles } from "../../src/harness/file-tools/find/command.ts";
import type { FindParams, FindSuccess } from "../../src/harness/file-tools/find/types.ts";
import { FileToolsHost } from "../../src/harness/file-tools/runtime/host.ts";
import { isFailed, type ToolOutcome } from "../../src/harness/file-tools/shared/result.ts";

export async function findWorkspaceFiles(
	cwd: string,
	params: FindParams,
	signal?: AbortSignal,
): Promise<ToolOutcome<FindSuccess>> {
	const host = new FileToolsHost();
	try {
		const opened = await host.open({ cwd, sessionId: "find-test", ...(signal === undefined ? {} : { signal }) });
		if (isFailed(opened)) return opened;
		try {
			return await findFiles(params, opened);
		} finally {
			opened.dispose();
		}
	} finally {
		host.dispose();
	}
}
