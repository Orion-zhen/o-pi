import type { TSchema } from "typebox";
import { Errors } from "typebox/value";
import type { ProviderConfig } from "./schema.ts";
import type { ModelsDocument } from "./document.ts";

const corePayloadFields = new Set(["model", "messages", "input", "tools", "stream", "system", "contents", "systemInstruction"]);

/** 保存、加载和表单共用校验，不解析凭据或执行命令。 */
export function modelsConfigIssues(config: ModelsDocument, schema: TSchema): string[] {
	const issues = Errors(schema, config).map((error) => `${error.instancePath || "/"}: ${error.message}`);
	if (issues.length) return [...new Set(issues)];
	for (const [id, value] of Object.entries(config.providers)) {
		const options = value as ProviderConfig;
		for (const key of ["timeoutMs", "maxRetries"]) {
			if (value[key] !== undefined) issues.push(`providers.${id}.${key}: extension removed; remove this field to use SDK defaults`);
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
