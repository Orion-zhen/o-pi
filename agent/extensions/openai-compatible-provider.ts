import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	defaultModelsJsoncPath,
	ensure_private_config_permissions,
	loadModelsJsoncConfig,
	registerOpenAICompatibleProviders,
} from "../../src/openai-compatible-provider/index.js";
import { clearThinkingDisplayResolver } from "../../src/thinking-level/display-capability.js";

/** 从 ~/.pi/agent/models.jsonc 注册原生 pi-ai OpenAI-compatible provider。 */
export default async function openAICompatibleProvider(pi: ExtensionAPI): Promise<void> {
	clearThinkingDisplayResolver(pi.events);
	const configPath = defaultModelsJsoncPath();
	const warning = await ensure_private_config_permissions(configPath);
	if (warning) console.warn(warning);

	const config = await loadModelsJsoncConfig(configPath);
	if (!config) return;
	registerOpenAICompatibleProviders(pi, config, configPath);
}
