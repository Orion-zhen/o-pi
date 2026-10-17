import type { TSchema } from "typebox";
import { Errors } from "typebox/value";
import { hasRequestExtensions, ProviderConfigSchema, thinkingPresetIssue, type ProviderOptions } from "./schema.ts";
import { configuredModels } from "./model-settings.ts";
import type { ModelsDocument } from "./document.ts";

const corePayloadFields = new Set(["model", "messages", "input", "tools", "stream"]);

/** 保存、加载和表单共用校验，不解析凭据或执行命令。 */
export function modelsConfigIssues(config: ModelsDocument, schema: TSchema): string[] {
	const issues = Errors(schema, config).map((error) => `${error.instancePath || "/"}: ${error.message}`);
	if (issues.length) return [...new Set(issues)];
	for (const [id, value] of Object.entries(config.providers)) {
		const options = value as ProviderOptions;
		if (hasRequestExtensions(options)) {
			for (const error of Errors(ProviderConfigSchema, value)) issues.push(`providers.${id}${error.instancePath}: ${error.message}`);
		}
		const providerIssue = thinkingPresetIssue(value.api, options.thinkingPreset);
		if (providerIssue) issues.push(`${id}.thinkingPreset: ${providerIssue}`);
		for (const model of configuredModels(value)) {
			const issue = thinkingPresetIssue(
				model.configured.api ?? model.defaults.api ?? value.api,
				model.configured.thinkingPreset ?? model.defaults.thinkingPreset ?? options.thinkingPreset,
			);
			if (issue) issues.push(`${id}.${model.path.join(".")}.thinkingPreset: ${issue}`);
		}
		for (const key of Object.keys(options.extraBody ?? {})) {
			if (corePayloadFields.has(key)) issues.push(`${id}.extraBody cannot override "${key}"`);
		}
		for (const entry of [options, ...(options.models ?? []), ...Object.values(options.modelOverrides ?? {})]) {
			for (const key of entry.dropParams ?? []) {
				if (corePayloadFields.has(key)) issues.push(`${id}.dropParams cannot remove "${key}"`);
			}
		}
	}
	return issues;
}
