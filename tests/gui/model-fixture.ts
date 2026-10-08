import { writeFile } from "node:fs/promises";
import path from "node:path";

/** 共享模型连接默认值；用例只声明与被测行为有关的差异。 */
export async function configureModel(agentDir: string, baseUrl: string, provider: string, options: {
	name?: string;
	reasoning?: boolean;
	apiKey?: string;
	settings?: Record<string, unknown>;
} = {}): Promise<void> {
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
		defaultProjectTrust: "never", defaultProvider: provider, defaultModel: "test",
		compaction: { enabled: false }, retry: { enabled: false }, ...options.settings,
	}));
	await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { [provider]: {
		api: "openai-completions", baseUrl, apiKey: options.apiKey ?? "fixture",
		models: [{ id: "test", name: options.name ?? "Test", reasoning: options.reasoning, input: ["text"],
			contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
}
