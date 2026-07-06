import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv/dist/ajv.js";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

import { invalidModelsJsonc } from "./errors.js";
import { COMPAT_PRESETS } from "./presets.js";
import { ModelsJsoncConfigSchema, type ModelsJsoncConfig } from "./schema.js";

let validateModelsJsonc: ValidateFunction | undefined;

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

	const validate = getValidator();
	if (!validate(parsed)) {
		throw invalidModelsJsonc(configPath, formatSchemaError(validate.errors?.[0]));
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

function getValidator() {
	if (!validateModelsJsonc) {
		validateModelsJsonc = new Ajv({ allErrors: false }).compile(ModelsJsoncConfigSchema);
	}
	return validateModelsJsonc;
}

function formatSchemaError(error: ErrorObject | undefined): string {
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

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

const PROVIDER_SAMPLING_FIELDS = new Set([
	"defaults",
	"temperature",
	"top_p",
	"top_k",
	"min_p",
	"max_tokens",
	"presence_penalty",
	"frequency_penalty",
	"repetition_penalty",
	"seed",
	"stop",
]);
const REASONING_EFFORT_VALUES = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function prevalidateModelsJsonc(value: unknown, configPath: string): void {
	if (!isRecord(value) || !isRecord(value.providers)) return;
	const expectedCompat = Object.keys(COMPAT_PRESETS).join(", ");
	for (const [providerId, provider] of Object.entries(value.providers)) {
		if (!isRecord(provider)) continue;
		for (const field of Object.keys(provider)) {
			if (!PROVIDER_SAMPLING_FIELDS.has(field)) continue;
			if (field === "defaults") {
				throw invalidModelsJsonc(configPath, `provider "${providerId}" contains provider-level "defaults"; move sampling defaults under each model`);
			}
			throw invalidModelsJsonc(
				configPath,
				`Provider "${providerId}" contains provider-level sampling defaults. Sampling defaults are only supported under each model.`,
			);
		}
		if (typeof provider.compat === "string" && !(provider.compat in COMPAT_PRESETS)) {
			throw invalidModelsJsonc(configPath, `provider "${providerId}" has unknown compat preset "${provider.compat}"; expected one of ${expectedCompat}`);
		}
		if (Array.isArray(provider.models)) {
			for (let index = 0; index < provider.models.length; index++) {
				const model = provider.models[index];
				if (isRecord(model) && typeof model.model !== "string") {
					throw invalidModelsJsonc(configPath, `providers.${providerId}.models[${index}].model is required`);
				}
				if (isRecord(model) && "reasoning" in model) {
					throw invalidModelsJsonc(configPath, `providers.${providerId}.models[${index}].reasoning is not supported; use reasoning_effort instead`);
				}
				if (isRecord(model) && typeof model.reasoning_effort === "string" && !REASONING_EFFORT_VALUES.has(model.reasoning_effort)) {
					throw invalidModelsJsonc(
						configPath,
						`providers.${providerId}.models[${index}].reasoning_effort must be one of off, minimal, low, medium, high, xhigh`,
					);
				}
			}
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
