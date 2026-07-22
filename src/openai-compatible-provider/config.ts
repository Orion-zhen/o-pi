import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

import { isNotFound } from "../config-loader.js";
import { compileSchemaValidator, type SchemaValidationError } from "../schema-validator.js";
import { invalidModelsJsonc } from "./errors.js";
import { COMPAT_PRESET_NAMES, ModelsJsoncConfigSchema, THINKING_PRESET_NAMES, type ModelsJsoncConfig } from "./schema.js";

const validateModelsJsonc = compileSchemaValidator(ModelsJsoncConfigSchema);

/** models.jsonc 的默认位置；扩展只读取该 JSONC 文件，不触碰 Pi 原生 models.json。 */
export function defaultModelsJsoncPath(): string {
	return path.join(getAgentDir(), "models.jsonc");
}

/** 读取并校验 models.jsonc；文件不存在时返回 undefined，表示不注册任何 provider。 */
export async function loadModelsJsoncConfig(configPath = defaultModelsJsoncPath()): Promise<ModelsJsoncConfig | undefined> {
	try {
		await access(configPath, constants.F_OK);
	} catch (error) {
		if (isNotFound(error)) return undefined;
		throw invalidModelsJsonc(configPath, "file cannot be accessed");
	}

	const text = await readFile(configPath, "utf8");
	const parseErrors: ParseError[] = [];
	const parsed = parse(text, parseErrors, { allowTrailingComma: true });
	if (parseErrors.length > 0) {
		const first = parseErrors[0];
		const code = first ? printParseErrorCode(first.error) : "Unknown";
		throw invalidModelsJsonc(configPath, `JSONC parse error: ${code}`);
	}
	prevalidateModelsJsonc(parsed, configPath);

	if (!validateModelsJsonc(parsed)) {
		throw invalidModelsJsonc(configPath, formatSchemaError(validateModelsJsonc.errors?.[0]));
	}
	return parsed as ModelsJsoncConfig;
}

/** 检查私有模型配置权限；过宽时返回 warning，由扩展决定如何展示。 */
export async function ensure_private_config_permissions(configPath = defaultModelsJsoncPath()): Promise<string | undefined> {
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

function formatSchemaError(error: SchemaValidationError | undefined): string {
	if (!error) return "schema validation failed";
	const pathText = formatInstancePath(error.instancePath);
	if (error.keyword === "required") {
		const missing = typeof error.params.missingProperty === "string" ? error.params.missingProperty : "property";
		return `${pathText ? `${pathText}.` : ""}${missing} is required`;
	}
	if (error.keyword === "additionalProperties") {
		const property = typeof error.params.additionalProperty === "string" ? error.params.additionalProperty : "property";
		return `${pathText ? `${pathText}.` : ""}${property} is not supported`;
	}
	return `${pathText || "root"} ${error.message ?? "is invalid"}`;
}

function formatInstancePath(instancePath: string): string {
	if (!instancePath) return "";
	return instancePath
		.split("/")
		.filter(Boolean)
		.map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
		.map((part) => (/^\d+$/.test(part) ? `[${part}]` : `.${part}`))
		.join("")
		.replace(/^\./, "")
		.replace(/\.\[/g, "[");
}

const COMPAT_PRESET_NAME_SET = new Set<string>(COMPAT_PRESET_NAMES);
const THINKING_PRESET_NAME_SET = new Set<string>(THINKING_PRESET_NAMES);
const LEGACY_PROVIDER_FIELDS: Record<string, string> = {
	display_name: "name",
	base_url: "baseUrl",
	api_key: "apiKey",
	models_endpoint: "modelsEndpoint",
	thinking: "thinkingPreset",
	advanced: "direct provider fields",
};
const LEGACY_DEFAULT_FIELDS: Record<string, string> = {
	top_p: "topP",
	top_k: "topK",
	min_p: "minP",
	max_tokens: "maxTokens",
	presence_penalty: "presencePenalty",
	frequency_penalty: "frequencyPenalty",
	repetition_penalty: "repetitionPenalty",
};
const LEGACY_MODEL_FIELDS: Record<string, string> = {
	model: "id",
	display_name: "name",
	context_window: "contextWindow",
	max_tokens: "maxTokens",
	thinking: "thinkingPreset",
	thinking_level: "defaultThinkingLevel",
	thinking_level_map: "thinkingLevelMap",
	advanced: "direct model fields",
};

function prevalidateModelsJsonc(value: unknown, configPath: string): void {
	if (!isRecord(value) || !isRecord(value.providers)) return;
	const expectedCompat = COMPAT_PRESET_NAMES.join(", ");
	const expectedThinking = THINKING_PRESET_NAMES.join(", ");
	for (const [providerId, provider] of Object.entries(value.providers)) {
		if (!isRecord(provider)) continue;
		assertNoLegacyFields(provider, `providers.${providerId}`, LEGACY_PROVIDER_FIELDS, configPath);
		if (provider.api === "chat" || provider.api === "responses") {
			throw invalidModelsJsonc(configPath, `providers.${providerId}.api must use openai-completions or openai-responses`);
		}
		if (typeof provider.compatPreset === "string" && !COMPAT_PRESET_NAME_SET.has(provider.compatPreset)) {
			throw invalidModelsJsonc(configPath, `provider "${providerId}" has unknown compatPreset "${provider.compatPreset}"; expected one of ${expectedCompat}`);
		}
		if (typeof provider.thinkingPreset === "string" && !THINKING_PRESET_NAME_SET.has(provider.thinkingPreset)) {
			throw invalidModelsJsonc(configPath, `provider "${providerId}" has unknown thinkingPreset "${provider.thinkingPreset}"; expected one of ${expectedThinking}`);
		}
		if (typeof provider.compat === "string") {
			throw invalidModelsJsonc(configPath, `provider "${providerId}" compat must be a Pi compat object; use compatPreset for presets`);
		}
		if (Array.isArray(provider.models)) {
			for (let index = 0; index < provider.models.length; index++) {
				const model = provider.models[index];
				if (isRecord(model)) assertNoLegacyFields(model, `providers.${providerId}.models[${index}]`, LEGACY_MODEL_FIELDS, configPath);
				if (isRecord(model?.defaults)) {
					assertNoLegacyFields(model.defaults, `providers.${providerId}.models[${index}].defaults`, LEGACY_DEFAULT_FIELDS, configPath);
				}
				if (isRecord(model) && typeof model.id !== "string") {
					throw invalidModelsJsonc(configPath, `providers.${providerId}.models[${index}].id is required`);
				}
				if (isRecord(model) && "reasoning_effort" in model) {
					throw invalidModelsJsonc(
						configPath,
						`providers.${providerId}.models[${index}].reasoning_effort is not supported; use reasoning/defaultThinkingLevel`,
					);
				}
				if (isRecord(model) && typeof model.thinkingPreset === "string" && !THINKING_PRESET_NAME_SET.has(model.thinkingPreset)) {
					throw invalidModelsJsonc(
						configPath,
						`providers.${providerId}.models[${index}] has unknown thinkingPreset "${model.thinkingPreset}"; expected one of ${expectedThinking}`,
					);
				}
			}
		}
	}
}

function assertNoLegacyFields(
	value: Record<string, unknown>,
	path: string,
	renames: Record<string, string>,
	configPath: string,
): void {
	for (const [legacy, replacement] of Object.entries(renames)) {
		if (legacy in value) throw invalidModelsJsonc(configPath, `${path}.${legacy} was replaced by ${replacement}`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
