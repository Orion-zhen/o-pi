import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	defaultModelsPath,
	ensure_private_config_permissions,
	loadModelsConfig,
	registerOpenAICompatibleProviders,
} from "../openai-compatible-provider/index.ts";

/** 只为 models.json 中显式启用的 OpenAI 兼容扩展注册 provider。 */
export default async function openAICompatibleProvider(pi: ExtensionAPI): Promise<void> {
	const configPath = defaultModelsPath();
	const warning = await ensure_private_config_permissions(configPath);
	if (warning) console.warn(warning);

	const config = await loadModelsConfig(configPath);
	if (!config) return;
	registerOpenAICompatibleProviders(pi, config, configPath);
}
