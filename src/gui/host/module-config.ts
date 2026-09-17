import { readFile } from "node:fs/promises";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import {
	CONFIG_DEFINITIONS, agentSchemaPath, createSchemaValidator, isNotFound,
	defaultAgentConfigPath, userAgentConfigPath, userAgentPath,
} from "../../harness/config-loader.ts";
import { replaceConfigFile } from "./files.ts";
import { moduleConfigIds, type ModuleConfigId, type ModuleConfigDocument } from "../module-config.ts";

const validators = new Map(moduleConfigIds.map((id) => {
	const name = id === "tools" ? "tools.jsonc" : CONFIG_DEFINITIONS[id].fileName;
	return [id, createSchemaValidator({
		schemaPath: agentSchemaPath(name.replace(".jsonc", ".schema.json")), label: name,
		createError: (message) => new Error(message),
	})];
}));

function paths(id: ModuleConfigId) {
	if (id === "tools") return { user: userAgentPath("tools.jsonc", "PI_TOOLS_CONFIG") };
	const definition = CONFIG_DEFINITIONS[id];
	return {
		user: userAgentConfigPath(definition.fileName, definition.userEnv),
		defaults: defaultAgentConfigPath(definition.fileName),
	};
}

export async function readModuleConfig(id: ModuleConfigId): Promise<ModuleConfigDocument> {
	const locations = paths(id);
	let content: string;
	try { content = await readFile(locations.user, "utf8"); }
	catch (error) { if (isNotFound(error)) content = ""; else throw error; }
	return {
		path: locations.user, content,
		defaults: locations.defaults ? await readFile(locations.defaults, "utf8") : "{}",
	};
}

export async function saveModuleConfig(id: ModuleConfigId, original: string, content: string): Promise<void> {
	const errors: ParseError[] = [];
	const value: unknown = parse(content.replace(/^\uFEFF/, ""), errors, { allowTrailingComma: true });
	if (errors.length) throw new Error(`JSONC 错误: ${errors.map((error) => `${printParseErrorCode(error.error)} @${error.offset}`).join(", ")}`);
	const load = validators.get(id);
	if (!load) throw new Error("未知配置。");
	const validate = await load();
	if (!validate(value)) throw new Error(`配置不符合 schema: ${JSON.stringify(validate.errors)}`);
	await replaceConfigFile(paths(id).user, original, content);
}
