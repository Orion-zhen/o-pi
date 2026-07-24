import { goAdapter } from "./adapters/go.js";
import { javascriptAdapter, jsxAdapter } from "./adapters/javascript.js";
import { pythonAdapter } from "./adapters/python.js";
import { rustAdapter } from "./adapters/rust.js";
import { tsxAdapter, typescriptAdapter } from "./adapters/typescript.js";
import type { LanguageAdapterMetadata } from "./adapters/types.js";
import type { CodeLanguage, SupportedCodeLanguage } from "./types.js";

export const LANGUAGE_ADAPTERS: readonly LanguageAdapterMetadata[] = [
	javascriptAdapter,
	jsxAdapter,
	typescriptAdapter,
	tsxAdapter,
	pythonAdapter,
	goAdapter,
	rustAdapter,
];

const adaptersByLanguage = new Map<SupportedCodeLanguage, LanguageAdapterMetadata>();
const adaptersByExtension = new Map<string, LanguageAdapterMetadata>();
for (const adapter of LANGUAGE_ADAPTERS) {
	if (adaptersByLanguage.has(adapter.language)) throw new Error(`Duplicate language adapter: ${adapter.language}`);
	adaptersByLanguage.set(adapter.language, adapter);
	for (const extension of adapter.extensions) {
		const normalized = extension.toLowerCase();
		if (adaptersByExtension.has(normalized)) throw new Error(`Duplicate language extension: ${normalized}`);
		adaptersByExtension.set(normalized, adapter);
	}
}

export function getLanguageAdapter(language: CodeLanguage): LanguageAdapterMetadata | undefined {
	return language === "text" ? undefined : adaptersByLanguage.get(language);
}

export function adapterFromPath(filePath: string): LanguageAdapterMetadata | undefined {
	const normalizedPath = filePath.toLowerCase().replaceAll("\\", "/");
	const fileName = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
	const extensionStart = fileName.lastIndexOf(".");
	if (extensionStart < 0) return undefined;
	return adaptersByExtension.get(fileName.slice(extensionStart));
}

export function languageFromPath(filePath: string): CodeLanguage {
	return adapterFromPath(filePath)?.language ?? "text";
}

export function registeredLanguageAdapters(): readonly LanguageAdapterMetadata[] {
	return LANGUAGE_ADAPTERS;
}
