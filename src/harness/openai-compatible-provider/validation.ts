import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import type { TSchema } from "typebox";
import { Errors } from "typebox/value";
import { hasProviderExtensions, hasRequestExtensions, ProviderConfigSchema, type ProviderOptions } from "./schema.ts";

export type ConfigObject = Record<string, unknown>;
export type ModelsDocument = ConfigObject & { providers: Record<string, ConfigObject> };
export function configObject(value: unknown): value is ConfigObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function parseModelsDocument(content: string): ModelsDocument {
	const errors: ParseError[] = [];
	const value: unknown = parse(content.replace(/^\uFEFF/, ""), errors, { allowTrailingComma: true });
	if (errors[0]) throw new Error(`JSON: ${printParseErrorCode(errors[0].error)}`);
	if (!configObject(value) || !configObject(value.providers) || !Object.values(value.providers).every(configObject))
		throw new Error("providers 必须是服务对象集合");
	return { ...value, providers: value.providers as Record<string, ConfigObject> };
}

const corePayloadFields = new Set(["model", "messages", "input", "tools", "stream"]);

/** 保存、加载和表单共用校验，不解析凭据或执行命令。 */
export function modelsConfigIssues(config: ModelsDocument, schema: TSchema): string[] {
	const issues = Errors(schema, config).map((error) => `${error.instancePath || "/"}: ${error.message}`);
	if (issues.length) return [...new Set(issues)];
	for (const [id, value] of Object.entries(config.providers)) {
		if (!hasProviderExtensions(value)) continue;
		const options = value as ProviderOptions;
		if (options.discoverModels || hasRequestExtensions(options)) {
			for (const error of Errors(ProviderConfigSchema, value)) issues.push(`providers.${id}${error.instancePath}: ${error.message}`);
		}
		for (const key of Object.keys(options.extraBody ?? {})) {
			if (corePayloadFields.has(key)) issues.push(`${id}.extraBody cannot override "${key}"`);
		}
		for (const entry of [options, ...(options.models ?? []), ...Object.values(options.modelOverrides ?? {})]) {
			for (const key of entry.dropParams ?? []) {
				if (corePayloadFields.has(key)) issues.push(`${id}.dropParams cannot remove "${key}"`);
			}
		}
		if (options.modelsEndpoint !== undefined && !options.discoverModels)
			issues.push(`${id}.modelsEndpoint requires discoverModels=true`);
	}
	return issues;
}
