import type { LspFileOperations } from "../../src/lsp/adapters/file-operations.js";

/** Pi 接入测试使用完整接口，未指定的增强不产生结果。 */
export function lspOperations(overrides: Partial<LspFileOperations> = {}): LspFileOperations {
	return {
		async prepareCodeAnalysis() {},
		async read() { return undefined; },
		async codeAnalysis() { return undefined; },
		async beforeMutation() { return undefined; },
		async afterMutation() { return undefined; },
		async afterMutationBatch(inputs) {
			return Promise.all(inputs.map((input) => overrides.afterMutation?.(input)));
		},
		...overrides,
	};
}
