import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

export type ConfigObject = Record<string, unknown>;
export type ModelsDocument = ConfigObject & { providers: Record<string, ConfigObject> };
export type ConfigPath = (string | number)[];

export const emptyModelsDocument = '{\n\t"providers": {}\n}\n';

export function configObject(value: unknown): value is ConfigObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCompatibleService(provider: ConfigObject): boolean {
	return provider.api === "openai-completions" || provider.api === "openai-responses";
}

export function parseModelsDocument(content: string): ModelsDocument {
	const errors: ParseError[] = [];
	const value: unknown = parse(content.replace(/^\uFEFF/, ""), errors, { allowTrailingComma: true });
	if (errors[0]) throw new Error(`JSON: ${printParseErrorCode(errors[0].error)}`);
	if (!configObject(value) || !configObject(value.providers) || !Object.values(value.providers).every(configObject)) {
		throw new Error("providers 必须是服务对象集合");
	}
	return { ...value, providers: value.providers as Record<string, ConfigObject> };
}
