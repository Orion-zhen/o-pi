import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

import { isNotFound, stripUtf8Bom } from "../config-loader.js";
import { compileSchemaValidator, type SchemaValidationError } from "../schema-validator.js";
import { invalidModelsJsonc } from "./errors.js";
import { ModelsJsoncConfigSchema, type ModelsJsoncConfig } from "./schema.js";

const validateModelsJsonc = compileSchemaValidator(ModelsJsoncConfigSchema);

/** models.jsonc 的默认位置；扩展只读取该 JSONC 文件，不触碰 Pi 原生 models.json。 */
export function defaultModelsJsoncPath(): string {
	return path.join(getAgentDir(), "models.jsonc");
}

/** 读取并校验 models.jsonc；文件不存在时返回 undefined，表示不注册任何 provider。 */
export async function loadModelsJsoncConfig(configPath = defaultModelsJsoncPath()): Promise<ModelsJsoncConfig | undefined> {
	let text: string;
	try {
		text = await readFile(configPath, "utf8");
	} catch (error) {
		if (isNotFound(error)) return undefined;
		throw invalidModelsJsonc(configPath, "file cannot be read");
	}
	const parseErrors: ParseError[] = [];
	const parsed = parse(stripUtf8Bom(text), parseErrors, { allowTrailingComma: true });
	if (parseErrors.length > 0) {
		const first = parseErrors[0];
		const code = first ? printParseErrorCode(first.error) : "Unknown";
		throw invalidModelsJsonc(configPath, `JSONC parse error: ${code}`);
	}
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
