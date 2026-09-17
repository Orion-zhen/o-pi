import {
	CONFIG_DEFINITIONS,
	agentSchemaPath,
	createCompleteSchemaValidator,
	createSchemaValidator,
	loadValidatedMergedConfig,
} from "../config-loader.ts";

export interface AutoTitleConfig {
	enabled: boolean;
	model: string | null;
	system_prompt: string;
}

const schemaOptions = {
	schemaPath: agentSchemaPath("auto-title.schema.json"),
	label: "auto-title",
	createError: (message: string, details?: Record<string, unknown>) => Object.assign(new Error(message), { details }),
};
const partial = createSchemaValidator(schemaOptions);
const complete = createCompleteSchemaValidator(schemaOptions);

export async function loadAutoTitleConfig(cwd: string): Promise<AutoTitleConfig> {
	const loaded = await loadValidatedMergedConfig(
		CONFIG_DEFINITIONS.autoTitle, cwd, schemaOptions.createError, { partial, complete },
	);
	return loaded.merged as AutoTitleConfig;
}
