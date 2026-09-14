import { findFiles } from "../../find/command.ts";
import type { FindParams } from "../../find/types.ts";
import { isFailed } from "../../shared/result.ts";
import { withFileToolsInvocation, type FileToolRuntime } from "../invocation.ts";

export async function executeFind(params: FindParams, runtime: FileToolRuntime) {
	return withFileToolsInvocation(runtime, async (opened) => {
		const result = await findFiles(params, opened);
		if (isFailed(result)) return result;
		return { content: [{ type: "text", text: result.content }], details: result.details };
	});
}
