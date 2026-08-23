import type { LspFileOperations } from "../../lsp/index.js";

export interface LspModule {
	lspFileOperations: LspFileOperations;
}

export type LazyLspFileOperations = LspFileOperations;

/** Loads LSP only when a tool-local composition port requests an enhancement. */
export function createLazyLspFileOperations(load: () => Promise<LspModule>): LazyLspFileOperations {
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
			return (await getModule()).lspFileOperations.prepareCodeAnalysis?.(input);
		},
		async read(input) {
			return (await getModule()).lspFileOperations.read?.(input);
		},
		async codeAnalysis(input) {
			return (await getModule()).lspFileOperations.codeAnalysis?.(input);
		},
		async beforeMutation(input) {
			return (await getModule()).lspFileOperations.beforeMutation?.(input);
		},
		async afterMutation(input) {
			return (await getModule()).lspFileOperations.afterMutation?.(input);
		},
		async afterMutationBatch(inputs) {
			const operations = (await getModule()).lspFileOperations;
			if (operations.afterMutationBatch !== undefined) return await operations.afterMutationBatch(inputs);
			return await Promise.all(inputs.map((input) => operations.afterMutation?.(input)));
		},
	};
}
