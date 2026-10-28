import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createAgentSessionFromServices, createAgentSessionServices, createAgentSessionRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import modelServices from "../../../src/harness/extensions/model-services.ts";

export async function saveModelService(dir: string, provider: Record<string, unknown>, providerId = "gateway") {
	await writeFile(path.join(dir, "models.json"), JSON.stringify({ providers: { [providerId]: provider } }), { mode: 0o600 });
}

export async function startModelSession(dir: string, provider: Record<string, unknown>, {
	providerId = "gateway", modelId = "m",
}: { providerId?: string; modelId?: string } = {}) {
	vi.stubEnv("PI_CODING_AGENT_DIR", dir);
	vi.stubEnv("PI_OFFLINE", "1");
	await saveModelService(dir, provider, providerId);
	await writeFile(path.join(dir, "settings.json"), JSON.stringify({
		defaultProvider: providerId, defaultModel: modelId, defaultThinkingLevel: "off",
		compaction: { enabled: false }, retry: { enabled: false },
	}));
	const runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd, agentDir,
			resourceLoaderOptions: {
				extensionFactories: [{ name: "model-services", factory: modelServices }],
				noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			},
		});
		return {
			...await createAgentSessionFromServices({ services, sessionManager, ...(sessionStartEvent ? { sessionStartEvent } : {}) }),
			services, diagnostics: services.diagnostics,
		};
	}, { cwd: dir, agentDir: dir, sessionManager: SessionManager.inMemory(dir) });
	await runtime.session.bindExtensions({ mode: "print" });
	return runtime;
}
