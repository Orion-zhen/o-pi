import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	defaultModelsJsoncPath,
	ensure_private_config_permissions,
	loadModelsJsoncConfig,
	normalizeModelsJsoncConfig,
	registerOpenAICompatibleProviders,
	resolveAutoModelsJsoncConfig,
} from "../../src/openai-compatible-provider/index.js";

/** 从 ~/.pi/agent/models.jsonc 注册 OpenAI-compatible provider。 */
export default async function openAICompatibleProvider(pi: ExtensionAPI): Promise<void> {
	const configPath = defaultModelsJsoncPath();
	const warning = await ensure_private_config_permissions(configPath);
	if (warning) console.warn(warning);

	const config = await loadModelsJsoncConfig(configPath);
	if (!config) return;

	const resolvedConfig = await resolveAutoModelsJsoncConfig(config, configPath);
	const providers = normalizeModelsJsoncConfig(resolvedConfig, configPath);
	registerOpenAICompatibleProviders(pi, providers);
}
