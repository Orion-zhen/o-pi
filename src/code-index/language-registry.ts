import { cAdapter } from "./adapters/c.js";
import { cppAdapter } from "./adapters/cpp.js";
import { goAdapter } from "./adapters/go.js";
import { javascriptAdapter, jsxAdapter } from "./adapters/javascript.js";
import { pythonAdapter } from "./adapters/python.js";
import { rustAdapter } from "./adapters/rust.js";
import { tsxAdapter, typescriptAdapter } from "./adapters/typescript.js";
import type { LanguageAdapter } from "./adapters/types.js";
import { TREE_SITTER_LANGUAGES } from "../syntax-tree/grammars.js";
import type { CodeLanguage, SupportedCodeLanguage } from "./types.js";

const specializedAdapters = new Map<SupportedCodeLanguage, LanguageAdapter>([
	["c", cAdapter],
	["cpp", cppAdapter],
	["go", goAdapter],
	["javascript", javascriptAdapter],
	["jsx", jsxAdapter],
	["python", pythonAdapter],
	["rust", rustAdapter],
	["tsx", tsxAdapter],
	["typescript", typescriptAdapter],
]);
let bashAdapterPromise: Promise<LanguageAdapter> | undefined;

/** 每个共享 catalog 注册项自动获得 code-index adapter；语义 adapter 按语言增强结果。 */
export const LANGUAGE_ADAPTERS: readonly LanguageAdapter[] = TREE_SITTER_LANGUAGES.map(
	(spec) => specializedAdapters.get(spec.language) ?? {
		...spec,
		extractUnits: (root, control) => specializedAdapters.get(spec.language)?.extractUnits(root, control) ?? [],
		extractImports: (root, control) => specializedAdapters.get(spec.language)?.extractImports(root, control) ?? [],
	},
);

export interface LanguageRegistry {
	getLanguageAdapter(language: CodeLanguage): LanguageAdapter | undefined;
	adapterFromPath(filePath: string): LanguageAdapter | undefined;
	languageFromPath(filePath: string): CodeLanguage;
	registeredLanguageAdapters(): readonly LanguageAdapter[];
}

/** 创建静态 registry；不做插件发现或 grammar 加载。 */
export function createLanguageRegistry(adapters: readonly LanguageAdapter[]): LanguageRegistry {
	const adaptersByLanguage = new Map<SupportedCodeLanguage, LanguageAdapter>();
	const adaptersByExtension = new Map<string, LanguageAdapter>();
	for (const adapter of adapters) {
		if (adaptersByLanguage.has(adapter.language)) throw new Error(`Duplicate language adapter: ${adapter.language}`);
		adaptersByLanguage.set(adapter.language, adapter);
		for (const extension of adapter.extensions) {
			const normalized = extension.toLowerCase();
			if (adaptersByExtension.has(normalized)) throw new Error(`Duplicate language extension: ${normalized}`);
			adaptersByExtension.set(normalized, adapter);
		}
	}

	function adapterFromPath(filePath: string): LanguageAdapter | undefined {
		const normalizedPath = filePath.toLowerCase().replaceAll("\\", "/");
		const fileName = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
		const extensionStart = fileName.lastIndexOf(".");
		if (extensionStart < 0) return undefined;
		return adaptersByExtension.get(fileName.slice(extensionStart));
	}

	return {
		getLanguageAdapter(language) {
			return language === "text" ? undefined : adaptersByLanguage.get(language);
		},
		adapterFromPath,
		languageFromPath(filePath) {
			return adapterFromPath(filePath)?.language ?? "text";
		},
		registeredLanguageAdapters() {
			return adapters;
		},
	};
}

const registry = createLanguageRegistry(LANGUAGE_ADAPTERS);

export function getLanguageAdapter(language: CodeLanguage): LanguageAdapter | undefined {
	return registry.getLanguageAdapter(language);
}

/** 只在实际分析 Bash 文件时加载其语义提取器；其他语言不承担该模块的冷启动成本。 */
export async function loadLanguageAdapter(language: CodeLanguage): Promise<LanguageAdapter | undefined> {
	const adapter = getLanguageAdapter(language);
	if (language !== "bash") return adapter;
	bashAdapterPromise ??= import("./adapters/bash.js").then((module) => {
		specializedAdapters.set("bash", module.bashAdapter);
		return module.bashAdapter;
	});
	try {
		return await bashAdapterPromise;
	} catch {
		bashAdapterPromise = undefined;
		return adapter;
	}
}

export function adapterFromPath(filePath: string): LanguageAdapter | undefined {
	return registry.adapterFromPath(filePath);
}

export function languageFromPath(filePath: string): CodeLanguage {
	return registry.languageFromPath(filePath);
}

export function registeredLanguageAdapters(): readonly LanguageAdapter[] {
	return registry.registeredLanguageAdapters();
}
