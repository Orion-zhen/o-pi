import type { FileToolLspHooks } from "../types.js";

export interface LspModule {
	lspFileHooks: FileToolLspHooks;
}

/** LSP 模块只在某个文件工具实际请求增强时加载。 */
export function createLazyLspFileHooks(load: () => Promise<LspModule>): FileToolLspHooks {
	return {
		async enhanceRead(input) {
			return (await load()).lspFileHooks.enhanceRead?.(input);
		},
		async grepSymbols(input) {
			return (await load()).lspFileHooks.grepSymbols?.(input) ?? [];
		},
		async beforeEdit(input) {
			return (await load()).lspFileHooks.beforeEdit?.(input);
		},
		async afterWrite(input) {
			return (await load()).lspFileHooks.afterWrite?.(input);
		},
		async afterEdit(input) {
			return (await load()).lspFileHooks.afterEdit?.(input);
		},
	};
}
