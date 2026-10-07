import { readFile } from "node:fs/promises";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import {
	CONFIG_DEFINITIONS, agentSchemaPath, createSchemaValidator, isNotFound,
	defaultAgentConfigPath, userAgentConfigPath,
} from "../../harness/config-loader.ts";
import { replaceConfigFile } from "./files.ts";
import { moduleConfigIds, type ModuleConfigId, type ModuleConfigDocument } from "../module-config.ts";
import { moduleConfigOptions } from "./module-config-options.ts";

const validators = Object.fromEntries(moduleConfigIds.map((id) => {
	const name = CONFIG_DEFINITIONS[id].fileName;
	return [id, createSchemaValidator({
		schemaPath: agentSchemaPath(name.replace(".jsonc", ".schema.json")), label: name,
		createError: (message) => new Error(message),
	})];
})) as Record<ModuleConfigId, ReturnType<typeof createSchemaValidator>>;

function paths(id: ModuleConfigId) {
	const definition = CONFIG_DEFINITIONS[id];
	return {
		user: userAgentConfigPath(definition.fileName, definition.userEnv),
		defaults: defaultAgentConfigPath(definition.fileName),
	};
}

export async function readModuleConfig(id: ModuleConfigId): Promise<ModuleConfigDocument> {
	const locations = paths(id);
	const [validate, defaults] = await Promise.all([validators[id](), readFile(locations.defaults, "utf8")]);
	let content: string;
	try { content = await readFile(locations.user, "utf8"); }
	catch (error) { if (isNotFound(error)) content = ""; else throw error; }
	return {
		path: locations.user, content, defaults,
		...moduleConfigOptions(validate.schema),
	};
}

export async function saveModuleConfig(id: ModuleConfigId, original: string, content: string): Promise<void> {
	const errors: ParseError[] = [];
	const value: unknown = parse(content.replace(/^\uFEFF/, ""), errors, { allowTrailingComma: true });
	if (errors.length) throw new Error(`JSONC 错误: ${errors.map((error) => `${printParseErrorCode(error.error)} @${error.offset}`).join(", ")}`);
	const validate = await validators[id]();
	if (!validate(value)) throw new Error(`配置不符合 schema: ${JSON.stringify(validate.errors)}`);
	await replaceConfigFile(paths(id).user, original, content);
}
