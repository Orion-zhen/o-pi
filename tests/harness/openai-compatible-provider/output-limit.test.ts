import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
	createAgentSessionFromServices, createAgentSessionServices, createAgentSessionRuntime, SessionManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import openAICompatibleProvider from "../../../src/harness/extensions/openai-compatible-provider.ts";
import { providerConfig } from "./fixtures.ts";
import { useOpenAICompatibleProviderTestSetup } from "./test-support.ts";

const temp = useOpenAICompatibleProviderTestSetup();

async function start(provider: Record<string, unknown>) {
	vi.stubEnv("PI_CODING_AGENT_DIR", temp.path);
	vi.stubEnv("PI_OFFLINE", "1");
	await save(provider);
	await writeFile(path.join(temp.path, "settings.json"), JSON.stringify({
		defaultProvider: "gateway", defaultModel: "m", defaultThinkingLevel: "off",
		compaction: { enabled: false }, retry: { enabled: false },
	}));
	const runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd, agentDir,
			resourceLoaderOptions: {
				extensionFactories: [{ name: "openai-compatible-provider", factory: openAICompatibleProvider }],
				noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			},
		});
		return {
			...await createAgentSessionFromServices({ services, sessionManager, ...(sessionStartEvent ? { sessionStartEvent } : {}) }),
			services, diagnostics: services.diagnostics,
		};
	}, { cwd: temp.path, agentDir: temp.path, sessionManager: SessionManager.inMemory(temp.path) });
	await runtime.session.bindExtensions({ mode: "print" });
	return runtime;
}

async function save(provider: Record<string, unknown>) {
	await writeFile(path.join(temp.path, "models.json"), JSON.stringify({ providers: { gateway: provider } }), { mode: 0o600 });
}

const protocols = [
	{ api: "openai-completions", field: "max_completion_tokens", compat: { maxTokensField: "max_completion_tokens" } },
	{ api: "openai-completions", field: "max_tokens", compat: { maxTokensField: "max_tokens" } },
	{ api: "openai-responses", field: "max_output_tokens", compat: {} },
];
const tokenFields = ["max_tokens", "max_completion_tokens", "max_output_tokens"];

describe("会话输出上限", () => {
	it.each(protocols.flatMap((protocol) => [false, true].map((extended) => ({ ...protocol, extended }))))(
		"$field extended=$extended 留空不发送，显式设置生效，清空后恢复不限", async ({ api, field, compat, extended }) => {
			const provider = providerConfig({ api, compat, ...(extended ? { extraBody: { custom: true } } : {}) });
			const runtime = await start(provider);
			const requests: unknown[] = [];
			vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
				requests.push(JSON.parse(String(init?.body)));
				return new Response('{"error":"stop after payload"}', { status: 400 });
			});
			const request = async (expected: number | undefined) => {
				const count = requests.length;
				await runtime.session.prompt("test");
				expect(requests).toHaveLength(count + 1);
				const payload = requests.at(-1);
				if (expected === undefined) for (const key of tokenFields) expect(payload).not.toHaveProperty(key);
				else expect(payload).toHaveProperty(field, expected);
				if (extended) expect(payload).toHaveProperty("custom", true);
			};
			const reload = async (models: unknown[], modelOverrides: Record<string, unknown> = {}) => {
				await save({ ...provider, models, modelOverrides });
				await runtime.session.reload();
				// 与 GUI 重载一致：刷新模型目录，并替换会话持有的旧模型对象。
				await runtime.services.modelRuntime.refresh({ allowNetwork: false });
				const model = runtime.services.modelRuntime.getModel("gateway", "m");
				if (!model) throw new Error("model missing after reload");
				runtime.session.agent.state.model = model;
			};
			try {
				await request(undefined);
				await reload([{ id: "m", maxTokens: 8192 }]);
				await request(8192);
				await reload([{ id: "m", maxTokens: 8192 }], { m: { maxTokens: 4096 } });
				await request(4096);
				await reload([{ id: "m", maxTokens: 8192 }], { m: {} });
				await request(8192);
				await reload([{ id: "m" }], { m: { name: "Renamed" } });
				await request(undefined);
			} finally {
				await runtime.dispose();
			}
		},
	);

	it("不删除 Anthropic 协议要求的输出预算", async () => {
		const runtime = await start(providerConfig({ api: "anthropic-messages" }));
		let payload: unknown;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			payload = JSON.parse(String(init?.body));
			return new Response('{"error":"stop after payload"}', { status: 400 });
		});
		try {
			await runtime.session.prompt("test");
			expect(payload).toHaveProperty("max_tokens", 16384);
		} finally {
			await runtime.dispose();
		}
	});
});
