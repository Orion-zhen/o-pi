import { readFile } from "node:fs/promises";
import { defaultModelsPath, modelsConfigSchema } from "../../../harness/openai-compatible-provider/config.ts";
import { parseModelsDocument } from "../../../harness/openai-compatible-provider/document.ts";
import { modelsConfigIssues } from "../../../harness/openai-compatible-provider/validation.ts";
import { isNotFound } from "../../../harness/config-loader.ts";
import { replaceConfigFile } from "../../../harness/config-file.ts";
import type { ModelServicesDocument } from "../../shared/config/model-services.ts";

export async function readModelServices(): Promise<ModelServicesDocument> {
	const path = defaultModelsPath();
	let content: string;
	try { content = await readFile(path, "utf8"); }
	catch (error) { if (isNotFound(error)) content = ""; else throw error; }
	return { path, content, schema: modelsConfigSchema };
}

export async function saveModelServices(original: string, content: string): Promise<void> {
	const issues = modelsConfigIssues(parseModelsDocument(content), modelsConfigSchema);
	if (issues.length) throw new Error(issues.join("\n"));
	await replaceConfigFile(defaultModelsPath(), original, content);
}
