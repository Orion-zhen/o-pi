import { bashAdapter } from "./adapters/bash.js";
import { cAdapter } from "./adapters/c.js";
import { cppAdapter } from "./adapters/cpp.js";
import { goAdapter } from "./adapters/go.js";
import { javascriptAdapter, jsxAdapter } from "./adapters/javascript.js";
import { pythonAdapter } from "./adapters/python.js";
import { rustAdapter } from "./adapters/rust.js";
import { tsxAdapter, typescriptAdapter } from "./adapters/typescript.js";
import type { LanguageAdapter } from "./adapters/types.js";
import type { CodeLanguage, SupportedCodeLanguage } from "./types.js";

/** 所有受支持语言的固定 adapter 注册表，不会触发 Tree-sitter runtime 或 grammar 加载。 */
export const LANGUAGE_ADAPTERS = [
	javascriptAdapter,
	jsxAdapter,
	typescriptAdapter,
	tsxAdapter,
	pythonAdapter,
	goAdapter,
	rustAdapter,
	cAdapter,
	cppAdapter,
	bashAdapter,
] as const satisfies readonly LanguageAdapter[];

const adaptersByLanguage = new Map<SupportedCodeLanguage, LanguageAdapter>(
	LANGUAGE_ADAPTERS.map((adapter): [SupportedCodeLanguage, LanguageAdapter] => [adapter.language, adapter]),
);
const adaptersByExtension = new Map<string, LanguageAdapter>(
	LANGUAGE_ADAPTERS.flatMap((adapter) =>
		adapter.extensions.map((extension): [string, LanguageAdapter] => [extension.toLowerCase(), adapter]),
	),
);

export function getLanguageAdapter(language: CodeLanguage): LanguageAdapter | undefined {
	return language === "text" ? undefined : adaptersByLanguage.get(language);
}

export function adapterFromPath(filePath: string): LanguageAdapter | undefined {
	const normalizedPath = filePath.toLowerCase().replaceAll("\\", "/");
	const fileName = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
	const extensionStart = fileName.lastIndexOf(".");
	if (extensionStart < 0) return undefined;
	return adaptersByExtension.get(fileName.slice(extensionStart));
}

export function languageFromPath(filePath: string): CodeLanguage {
	return adapterFromPath(filePath)?.language ?? "text";
}
