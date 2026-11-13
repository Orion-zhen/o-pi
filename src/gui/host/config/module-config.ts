import { readFile } from "node:fs/promises";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import {
	CONFIG_DEFINITIONS, configSchema, isNotFound,
	defaultAgentConfigPath, userAgentConfigPath,
} from "../../../harness/config-loader.ts";
import { replaceConfigFile } from "../../../harness/config-file.ts";
import { type ModuleConfigId, type ModuleConfigDocument } from "../../shared/config/modules.ts";

function paths(id: ModuleConfigId) {
	const definition = CONFIG_DEFINITIONS[id];
	return {
		user: userAgentConfigPath(definition.fileName, definition.userEnv),
		defaults: defaultAgentConfigPath(definition.fileName),
	};
}

export async function readModuleConfig(id: ModuleConfigId): Promise<ModuleConfigDocument> {
	const locations = paths(id);
	const { schema } = configSchema(CONFIG_DEFINITIONS[id]);
	const defaults = await readFile(locations.defaults, "utf8");
	let content: string;
	try { content = await readFile(locations.user, "utf8"); }
	catch (error) { if (isNotFound(error)) content = ""; else throw error; }
	return {
		path: locations.user, content, defaults, schema,
	};
}

export async function saveModuleConfig(id: ModuleConfigId, original: string, content: string): Promise<void> {
	const errors: ParseError[] = [];
	const value: unknown = parse(content.replace(/^\uFEFF/, ""), errors, { allowTrailingComma: true });
	if (errors.length) throw new Error(`JSONC 错误: ${errors.map((error) => `${printParseErrorCode(error.error)} @${error.offset}`).join(", ")}`);
	const { validator } = configSchema(CONFIG_DEFINITIONS[id]);
	if (!validator.check(value)) throw new Error(`配置不符合 schema: ${JSON.stringify(validator.errors(value))}`);
	await replaceConfigFile(paths(id).user, original, content);
}
