import { readFile } from "node:fs/promises";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import {
	CONFIG_DEFINITIONS, configValidator, isNotFound,
	defaultAgentConfigPath, userAgentConfigPath,
} from "../../../harness/config-loader.ts";
import { replaceConfigFile } from "../session/files.ts";
import { type ModuleConfigId, type ModuleConfigDocument } from "../../module-config.ts";
import { moduleConfigOptions } from "./module-config-options.ts";

function paths(id: ModuleConfigId) {
	const definition = CONFIG_DEFINITIONS[id];
	return {
		user: userAgentConfigPath(definition.fileName, definition.userEnv),
		defaults: defaultAgentConfigPath(definition.fileName),
	};
}

export async function readModuleConfig(id: ModuleConfigId): Promise<ModuleConfigDocument> {
	const locations = paths(id);
	const validate = configValidator(CONFIG_DEFINITIONS[id]);
	const defaults = await readFile(locations.defaults, "utf8");
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
	const validate = configValidator(CONFIG_DEFINITIONS[id]);
	if (!validate(value)) throw new Error(`配置不符合 schema: ${JSON.stringify(validate.errors)}`);
	await replaceConfigFile(paths(id).user, original, content);
}
