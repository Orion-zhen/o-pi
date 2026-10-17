import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { Type } from "typebox";

import { isNotFound, stripUtf8Bom } from "../config-loader.ts";
import { compileSchemaValidator, type SchemaValidationError } from "../schema-validator.ts";
import { invalidModelsConfig } from "./errors.ts";
import { hasProviderExtensions, hasRequestExtensions, ProviderConfigSchema, ProviderOptionsSchema, type ModelsConfig, type ProviderConfig, type ProviderOptions } from "./schema.ts";

const validateRoot = compileSchemaValidator(Type.Object({ providers: Type.Record(Type.String(), Type.Unknown()) }));
const validateOptions = compileSchemaValidator(ProviderOptionsSchema);
const validateProvider = compileSchemaValidator(ProviderConfigSchema);
const CORE_PAYLOAD_FIELDS = new Set(["model", "messages", "input", "tools", "stream"]);

export function defaultModelsPath(): string {
	return path.join(getAgentDir(), "models.json");
}

/** 普通 provider 完全交给 SDK，只读取显式启用的扩展配置。 */
export async function loadModelsConfig(configPath: string): Promise<ModelsConfig | undefined> {
	let text: string;
	try {
		text = await readFile(configPath, "utf8");
	} catch (error) {
		if (isNotFound(error)) return undefined;
		throw invalidModelsConfig(configPath, "file cannot be read");
	}
	const errors: ParseError[] = [];
	const parsed: unknown = parse(stripUtf8Bom(text), errors, { allowTrailingComma: true });
	if (errors[0]) throw invalidModelsConfig(configPath, `JSON parse error: ${printParseErrorCode(errors[0].error)}`);
	if (!validateRoot(parsed)) throw invalidModelsConfig(configPath, formatSchemaError(validateRoot.errors?.[0]));
	const root = parsed as { providers: Record<string, unknown> };
	const config: ModelsConfig = { providers: {}, defaultThinkingLevels: {} };
	for (const [id, value] of Object.entries(root.providers)) {
		if (typeof value !== "object" || value === null || !hasProviderExtensions(value)) continue;
		if (!validateOptions(value)) {
			throw invalidModelsConfig(configPath, `providers.${id}: ${formatSchemaError(validateOptions.errors?.[0])}`);
		}
		const options = value as ProviderOptions;
		validateProviderOptions(id, options, configPath);
		const models = [
			...(options.models ?? []).map((model) => [model.id, model] as const),
			...Object.entries(options.modelOverrides ?? {}),
		];
		for (const [modelId, model] of models) {
			if (model.defaultThinkingLevel !== undefined) {
				(config.defaultThinkingLevels[id] ??= {})[modelId] = model.defaultThinkingLevel;
			}
		}
		if (!options.discoverModels && !hasRequestExtensions(options)) continue;
		if (!validateProvider(value)) {
			throw invalidModelsConfig(configPath, `providers.${id}: ${formatSchemaError(validateProvider.errors?.[0])}`);
		}
		config.providers[id] = value as ProviderConfig;
	}
	return config;
}

export async function ensure_private_config_permissions(configPath: string): Promise<string | undefined> {
	if (process.platform === "win32") return undefined;
	let info;
	try {
		info = await stat(configPath);
	} catch (error) {
		if (isNotFound(error)) return undefined;
		throw error;
	}
	if ((info.mode & 0o077) === 0) return undefined;
	return `Warning: ${configPath} may contain API keys and is readable or writable by group/others. Run: chmod 600 ${configPath}`;
}

function validateProviderOptions(providerId: string, options: ProviderOptions, configPath: string): void {
	for (const key of Object.keys(options.extraBody ?? {})) {
		if (CORE_PAYLOAD_FIELDS.has(key)) throw invalidModelsConfig(configPath, `${providerId}.extraBody cannot override "${key}"`);
	}
	const entries = [options, ...(options.models ?? []), ...Object.values(options.modelOverrides ?? {})];
	for (const entry of entries) {
		for (const key of entry.dropParams ?? []) {
			if (CORE_PAYLOAD_FIELDS.has(key)) throw invalidModelsConfig(configPath, `${providerId}.dropParams cannot remove "${key}"`);
		}
	}
	if (options.modelsEndpoint !== undefined && !options.discoverModels) {
		throw invalidModelsConfig(configPath, `${providerId}.modelsEndpoint requires discoverModels=true`);
	}
}

function formatSchemaError(error: SchemaValidationError | undefined): string {
	if (!error) return "schema validation failed";
	const field = error.instancePath || "/";
	if (error.keyword === "required") return `${field}: ${String(error.params.missingProperty)} is required`;
	if (error.keyword === "additionalProperties") return `${field}: ${String(error.params.additionalProperty)} is not supported`;
	return `${field} ${error.message ?? "is invalid"}`;
}
