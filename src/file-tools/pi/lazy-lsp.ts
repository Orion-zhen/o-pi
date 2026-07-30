import type { LspFileOperations } from "../../lsp/file-hooks.js";

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
		async read(input) {
			return (await getModule()).lspFileOperations.read?.(input);
		},
		async codeAnalysis(input) {
			return (await getModule()).lspFileOperations.codeAnalysis?.(input);
		},
		async beforeEdit(input) {
			return (await getModule()).lspFileOperations.beforeEdit?.(input);
		},
		async afterWrite(input) {
			return (await getModule()).lspFileOperations.afterWrite?.(input);
		},
		async afterWriteBatch(inputs) {
			const operations = (await getModule()).lspFileOperations;
			if (operations.afterWriteBatch !== undefined) return await operations.afterWriteBatch(inputs);
			return await Promise.all(inputs.map((input) => operations.afterWrite?.(input)));
		},
	};
}
