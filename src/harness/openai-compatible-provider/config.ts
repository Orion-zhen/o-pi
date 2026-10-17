import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ModelsConfigSchema } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/model-config.js";
import { Type } from "typebox";

import { isNotFound } from "../config-loader.ts";
import { invalidModelsConfig } from "./errors.ts";
import { hasRequestExtensions, ProviderOptionsSchema, type ModelsConfig, type ProviderConfig, type ProviderOptions } from "./schema.ts";
import { parseModelsDocument } from "./document.ts";
import { modelsConfigIssues } from "./validation.ts";

const nativeProvider = Object.values(ModelsConfigSchema.properties.providers.patternProperties)[0];
if (!nativeProvider) throw new Error("SDK 缺少模型服务 schema");
export const modelsConfigSchema = Type.Object({ ...ModelsConfigSchema.properties,
	providers: Type.Record(Type.String(), Type.Intersect([nativeProvider, ProviderOptionsSchema])),
});

export function defaultModelsPath(): string {
	return path.join(getAgentDir(), "models.json");
}

/** 校验完整文档，只提取显式启用的扩展配置。 */
export async function loadModelsConfig(configPath: string): Promise<ModelsConfig | undefined> {
	let text: string;
	try {
		text = await readFile(configPath, "utf8");
	} catch (error) {
		if (isNotFound(error)) return undefined;
		throw invalidModelsConfig(configPath, "file cannot be read");
	}
	return parseModelsConfig(text, configPath);
}

export function parseModelsConfig(text: string, configPath: string): ModelsConfig {
	let source;
	try { source = parseModelsDocument(text); }
	catch (error) { throw invalidModelsConfig(configPath, error instanceof Error ? error.message : String(error)); }
	const issues = modelsConfigIssues(source, modelsConfigSchema);
	if (issues.length) throw invalidModelsConfig(configPath, issues.join("\n"));
	const config: ModelsConfig = { source, providers: {}, defaultThinkingLevels: {} };
	for (const [id, value] of Object.entries(source.providers)) {
		const options = value as ProviderOptions;
		const models = [
			...(options.models ?? []).map((model) => [model.id, model] as const),
			...Object.entries(options.modelOverrides ?? {}),
		];
		for (const [modelId, model] of models) {
			if (model.defaultThinkingLevel !== undefined) {
				(config.defaultThinkingLevels[id] ??= {})[modelId] = model.defaultThinkingLevel;
			}
		}
		if (hasRequestExtensions(options)) config.providers[id] = value as ProviderConfig;
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
