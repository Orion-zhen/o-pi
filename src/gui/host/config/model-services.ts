import { readFile } from "node:fs/promises";
import { getApiProviders } from "@earendil-works/pi-ai/compat";
import { defaultModelsPath } from "../../../harness/model-services/config.ts";
import { modelsConfigSchema } from "../../../harness/model-services/schema.ts";
import { parseModelsDocument } from "../../../harness/model-services/document.ts";
import { modelsConfigIssues } from "../../../harness/model-services/validation.ts";
import { isNotFound } from "../../../harness/config-loader.ts";
import { replaceConfigFile } from "../../../harness/config-file.ts";
import type { ModelServicesDocument } from "../../shared/config/model-services.ts";

export async function readModelServices(): Promise<ModelServicesDocument> {
	const path = defaultModelsPath();
	let content: string;
	try { content = await readFile(path, "utf8"); }
	catch (error) { if (isNotFound(error)) content = ""; else throw error; }
	return { path, content, schema: modelsConfigSchema, apis: getApiProviders().map(({ api }) => api) };
}

export async function saveModelServices(original: string, content: string): Promise<void> {
	const issues = modelsConfigIssues(parseModelsDocument(content), modelsConfigSchema);
	if (issues.length) throw new Error(issues.join("\n"));
	await replaceConfigFile(defaultModelsPath(), original, content);
}
