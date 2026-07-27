import type { LspFileOperations } from "../../lsp/file-hooks.js";

export interface LspModule {
	lspFileOperations: LspFileOperations;
	lspManager: { reload(): Promise<void> };
}

export interface LazyLspFileOperations extends LspFileOperations {
	shutdown(): Promise<void>;
}

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
		async symbols(input) {
			return (await getModule()).lspFileOperations.symbols?.(input) ?? [];
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
		async shutdown() {
			const active = pending;
			pending = undefined;
			if (active === undefined) return;
			const loaded = await active.catch(() => undefined);
			await loaded?.lspManager.reload();
		},
	};
}
