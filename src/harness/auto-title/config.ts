import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { CONFIG_DEFINITIONS, loadValidatedMergedConfig } from "../config-loader.ts";

export interface AutoTitleConfig {
	enabled: boolean;
	model: string | null;
	thinking_level: ModelThinkingLevel;
	system_prompt: string;
}

export async function loadAutoTitleConfig(cwd: string): Promise<AutoTitleConfig> {
	return (await loadValidatedMergedConfig<AutoTitleConfig>(CONFIG_DEFINITIONS.autoTitle, cwd)).merged;
}
