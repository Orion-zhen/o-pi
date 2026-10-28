import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelsConfig } from "../model-services/schema.ts";
import { defaultModelsPath, ensure_private_config_permissions, loadModelsConfig } from "../model-services/config.ts";
import { registerModelServices } from "../model-services/register.ts";

/** 为原生 models.json 配置安装会话请求与思考等级增强。 */
export default async function modelServices(pi: ExtensionAPI, loaded?: (config: ModelsConfig | undefined) => void): Promise<void> {
	loaded?.(undefined);
	const configPath = defaultModelsPath();
	const warning = await ensure_private_config_permissions(configPath);
	if (warning) console.warn(warning);

	const config = await loadModelsConfig(configPath);
	if (!config) return;
	registerModelServices(pi, config);
	loaded?.(config);
}
