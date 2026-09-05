import type { LspFileOperations } from "../../lsp/index.js";

export interface LspModule {
	lspFileOperations: LspFileOperations;
}

/** 文件工具首次请求增强时加载 LSP。 */
export function createLazyLspFileOperations(load: () => Promise<LspModule>): LspFileOperations {
	let pending: Promise<LspModule> | undefined;
	const getModule = (): Promise<LspModule> => {
		if (pending !== undefined) return pending;
		const created = load();
		pending = created;
		void created.catch(() => {
			if (pending === created) pending = undefined;
		});
		return created;
	};
	return {
		async prepareCodeAnalysis(input) {
			return (await getModule()).lspFileOperations.prepareCodeAnalysis(input);
		},
		async read(input) {
			return (await getModule()).lspFileOperations.read(input);
		},
		async codeAnalysis(input) {
			return (await getModule()).lspFileOperations.codeAnalysis(input);
		},
		async beforeMutation(input) {
			return (await getModule()).lspFileOperations.beforeMutation(input);
		},
		async afterMutation(input) {
			return (await getModule()).lspFileOperations.afterMutation(input);
		},
		async afterMutationBatch(inputs) {
			return (await getModule()).lspFileOperations.afterMutationBatch(inputs);
		},
	};
}
