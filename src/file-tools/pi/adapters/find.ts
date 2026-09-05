import { findFiles } from "../../find/command.js";
import type { FindParams } from "../../find/types.js";
import { isFailed } from "../../shared/result.js";
import { withFileToolsInvocation, type FileToolRuntime } from "../invocation.js";

export async function executeFind(params: FindParams, runtime: FileToolRuntime) {
	return withFileToolsInvocation(runtime, async (opened) => {
		const result = await findFiles(params, {
			filesystem: opened.filesystem,
			operation: opened.context,
			limits: opened.limits,
		});
		if (isFailed(result)) return result;
		return { content: [{ type: "text", text: result.content }], details: result.details };
	});
}
