import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GuiHost } from "../../src/gui/host/host.ts";
import { modelsConfigIssues, parseModelsDocument } from "../../src/harness/openai-compatible-provider/validation.ts";
import { editServiceConfig, serviceModels } from "../../src/gui/ui/model-services/service-draft.ts";
import { preserveEnv, setTestHome, useTempDir } from "../helpers/lifecycle.ts";

const temp = useTempDir("opi-model-services-");
preserveEnv("HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_OFFLINE");
let client: ReturnType<GuiHost["createClient"]>;
beforeEach(() => { setTestHome(temp.path); process.env.PI_CODING_AGENT_DIR = path.join(temp.path, ".pi", "agent"); client = new GuiHost().createClient(); });
afterEach(async () => { await client.host.dispose(); vi.restoreAllMocks(); });
const provider = { api: "openai-completions", baseUrl: "http://localhost:8080/v1", apiKey: "local", models: [{ id: "model" }] };

it("无会话时保存全局服务，保留注释、未知字段和非 OpenAI 服务", async () => {
	const initial = await client.query({ query: "modelServices" });
	expect(initial.content).toBe("");
	const source = '{\n// 中文注释\n"providers": {"local": {"api":"openai-completions", "baseUrl":"http://localhost/v1", "apiKey":"$KEY", "extra":true}, "anthropic": {"apiKey":"!secret-command"}}, "custom": 1\n}';
	await client.dispatch({ action: "saveModelServices", original: "", content: source });
	const edited = editServiceConfig(source, ["providers", "local", "name"], "本地模型");
	await client.dispatch({ action: "saveModelServices", original: source, content: edited });
	expect(await readFile(initial.path, "utf8")).toBe(edited);
	expect(edited).toContain("// 中文注释");
	expect(parseModelsDocument(edited)).toMatchObject({ providers: { local: { extra: true, apiKey: "$KEY" }, anthropic: { apiKey: "!secret-command" } }, custom: 1 });
	if (process.platform !== "win32") expect((await stat(initial.path)).mode & 0o777).toBe(0o600);
});

it("保存不执行密钥命令，前后端共用 SDK 与扩展字段校验", async () => {
	const marker = path.join(temp.path, "executed");
	const content = JSON.stringify({ providers: { local: { ...provider, apiKey: `!touch ${marker}`, discoverModels: true, thinkingPreset: "model-suffix" } } });
	const document = await client.query({ query: "modelServices" });
	expect(modelsConfigIssues(parseModelsDocument(content), document.schema)).toEqual([]);
	await client.dispatch({ action: "saveModelServices", original: "", content });
	await expect(access(marker)).rejects.toThrow();
});

it.each([
	{ maxRetries: -1 },
	{ models: [{ id: "model", contextWindow: 0 }] },
	{ extraBody: { model: "other" } },
])("前后端均拒绝无效配置 %j，不泄露密钥或写入文件", async (patch) => {
	const content = JSON.stringify({ providers: { local: { ...provider, apiKey: "secret-value", ...patch } } });
	const document = await client.query({ query: "modelServices" });
	expect(modelsConfigIssues(parseModelsDocument(content), document.schema).length).toBeGreaterThan(0);
	const result = client.dispatch({ action: "saveModelServices", original: "", content });
	await expect(result).rejects.toThrow();
	await expect(result).rejects.not.toThrow("secret-value");
	expect((await client.query({ query: "modelServices" })).content).toBe("");
});

it("修复损坏配置后，拒绝覆盖外部修改", async () => {
	const document = await client.query({ query: "modelServices" });
	await mkdir(path.dirname(document.path), { recursive: true });
	await writeFile(document.path, "{");
	expect((await client.query({ query: "modelServices" })).content).toBe("{");
	await client.dispatch({ action: "saveModelServices", original: "{", content: '{"providers":{}}' });
	const content = editServiceConfig('{"providers":{}}', ["providers", "local"], provider);
	const external = '{"providers":{"anthropic":{"apiKey":"$KEY"}}}';
	await writeFile(document.path, external);
	await expect(client.dispatch({ action: "saveModelServices", original: '{"providers":{}}', content })).rejects.toThrow("已被修改");
	expect(await readFile(document.path, "utf8")).toBe(external);
});

it("发现模型只写覆盖，已有手动模型覆盖优先，还原后保留原配置", () => {
	const config = { ...provider, models: [{ id: "manual", maxTokens: 10 }], modelOverrides: { manual: { maxTokens: 20 }, offline: { name: "离线" } } };
	const models = serviceModels(config, [{ id: "remote", name: "远程", contextWindow: 4096, maxTokens: 1024, reasoning: false, input: ["text"] }]);
	expect(models.map(({ id, path }) => [id, path])).toEqual([["manual", ["modelOverrides", "manual"]], ["remote", ["modelOverrides", "remote"]], ["offline", ["modelOverrides", "offline"]]]);
	expect(models[0]?.configured.maxTokens).toBe(20);
	expect(models[0]?.defaults.maxTokens).toBe(10);
	const original = JSON.stringify({ providers: { local: config } });
	const edited = editServiceConfig(original, ["providers", "local", "modelOverrides", "remote", "maxTokens"], 100);
	expect(parseModelsDocument(edited).providers.local).toMatchObject({ models: config.models, modelOverrides: { remote: { maxTokens: 100 } } });
	const reset = editServiceConfig(edited, ["providers", "local", "modelOverrides", "remote"], undefined);
	expect(parseModelsDocument(reset).providers.local).toEqual(config);
});

async function startSession(config: Record<string, unknown>) {
	process.env.PI_OFFLINE = "1";
	const document = await client.query({ query: "modelServices" });
	await client.dispatch({ action: "saveModelServices", original: "", content: JSON.stringify({ providers: { local: config } }) });
	const agentDir = path.dirname(document.path);
	await mkdir(path.join(agentDir, "configs"));
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never", defaultProvider: "local", defaultModel: "model" }));
	await writeFile(path.join(agentDir, "configs", "discord-presence.jsonc"), '{"enabled":false}');
	await client.host.start(temp.path);
}

it("目录不混入手动定义，保存后重新查询仍要求重载，重载后才允许刷新", async () => {
	await startSession({ ...provider, discoverModels: true, thinkingPreset: "model-suffix" });
	const catalog = () => client.query({ query: "modelServiceCatalog", provider: "local" });
	expect(await catalog()).toMatchObject({ models: [], reloadRequired: false, canRefresh: true });
	const document = await client.query({ query: "modelServices" });
	const content = editServiceConfig(document.content, ["providers", "local", "models"], []);
	await client.dispatch({ action: "saveModelServices", original: document.content, content });
	expect(await catalog()).toMatchObject({ models: [], reloadRequired: true, canRefresh: false });
	await expect(client.dispatch({ action: "refreshModelService", provider: "local" })).rejects.toThrow("重载");
	await client.dispatch({ action: "reload" });
	expect(await catalog()).toMatchObject({ models: [], reloadRequired: false, canRefresh: true });
	vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "remote" }, { id: "remote:high" }] })));
	await client.dispatch({ action: "refreshModelService", provider: "local" });
	expect((await catalog()).models.map(({ id }) => id)).toEqual(["remote"]);
	const saved = await client.query({ query: "modelServices" });
	const overridden = editServiceConfig(saved.content, ["providers", "local", "modelOverrides", "remote", "thinkingLevelMap", "high"], null);
	await client.dispatch({ action: "saveModelServices", original: saved.content, content: overridden });
	await client.dispatch({ action: "reload" });
	expect((await catalog()).models[0]?.thinkingLevelMap?.high).toBe("high");
	expect(client.runtime.services.modelRuntime.getModel("local", "remote")?.thinkingLevelMap?.high).toBeNull();
});

it("静态服务保存后提示重载，重载更新当前模型且不开放刷新", async () => {
	await startSession(provider);
	const document = await client.query({ query: "modelServices" });
	const content = editServiceConfig(document.content, ["providers", "local", "models", 0, "maxTokens"], 2048);
	await client.dispatch({ action: "saveModelServices", original: document.content, content });
	expect(await client.query({ query: "modelServiceCatalog", provider: "local" })).toMatchObject({ reloadRequired: true, canRefresh: false });
	await client.dispatch({ action: "reload" });
	expect(await client.query({ query: "modelServiceCatalog", provider: "local" })).toMatchObject({ reloadRequired: false, canRefresh: false });
	expect(client.runtime.services.modelRuntime.getModel("local", "model")?.maxTokens).toBe(2048);
	expect(client.runtime.session.model?.maxTokens).toBe(2048);
});
