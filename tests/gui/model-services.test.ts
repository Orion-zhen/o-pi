import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GuiHost } from "../../src/gui/host/host.ts";
import { parseModelsDocument } from "../../src/harness/openai-compatible-provider/document.ts";
import { modelsConfigIssues } from "../../src/harness/openai-compatible-provider/validation.ts";
import { editModelsDocument } from "../../src/harness/openai-compatible-provider/config-edits.ts";
import { configuredModels } from "../../src/harness/openai-compatible-provider/model-settings.ts";
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
	const edited = editModelsDocument(source, ["providers", "local", "name"], "本地模型");
	await client.dispatch({ action: "saveModelServices", original: source, content: edited });
	expect(await readFile(initial.path, "utf8")).toBe(edited);
	expect(edited).toContain("// 中文注释");
	expect(parseModelsDocument(edited)).toMatchObject({ providers: { local: { extra: true, apiKey: "$KEY" }, anthropic: { apiKey: "!secret-command" } }, custom: 1 });
	if (process.platform !== "win32") expect((await stat(initial.path)).mode & 0o777).toBe(0o600);
});

it("保存不执行密钥命令，前后端共用 SDK 与扩展字段校验", async () => {
	const marker = path.join(temp.path, "executed");
	const content = JSON.stringify({ providers: { local: { ...provider, apiKey: `!touch ${marker}`, thinkingPreset: "model-suffix" } } });
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
	const content = editModelsDocument('{"providers":{}}', ["providers", "local"], provider);
	const external = '{"providers":{"anthropic":{"apiKey":"$KEY"}}}';
	await writeFile(document.path, external);
	await expect(client.dispatch({ action: "saveModelServices", original: '{"providers":{}}', content })).rejects.toThrow("已被修改");
	expect(await readFile(document.path, "utf8")).toBe(external);
});

it("模型列表只展示显式配置，保留原生覆盖优先级，新增模型写入 models", () => {
	const config = { ...provider, models: [{ id: "manual", maxTokens: 10 }], modelOverrides: { manual: { maxTokens: 20 }, offline: { name: "离线" } } };
	const models = configuredModels(config);
	expect(models.map(({ id, path }) => [id, path])).toEqual([["manual", ["modelOverrides", "manual"]], ["offline", ["modelOverrides", "offline"]]]);
	expect(models[0]?.configured.maxTokens).toBe(20);
	expect(models[0]?.defaults.maxTokens).toBe(10);
	const original = JSON.stringify({ providers: { local: config } });
	const added = { id: "remote", contextWindow: 4096 };
	const edited = editModelsDocument(original, ["providers", "local", "models", 1], added);
	expect(parseModelsDocument(edited).providers.local).toMatchObject({ models: [...config.models, added], modelOverrides: config.modelOverrides });
	const reset = editModelsDocument(edited, ["providers", "local", "modelOverrides", "manual"], undefined);
	expect(parseModelsDocument(reset).providers.local).toMatchObject({ models: [...config.models, added], modelOverrides: { offline: { name: "离线" } } });
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

it("添加并保存后仍可获取候选、继续添加，统一重载才注册模型，删除后不会自动加入", async () => {
	const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ data: [
		{ id: "remote", context_length: 32768, architecture: { input_modalities: ["text", "image"] } }, { id: "remote:high" }, { id: "second" },
	] }));
	await startSession({ ...provider, thinkingPreset: "model-suffix" });
	expect(fetch).not.toHaveBeenCalled();
	const catalog = () => client.query({ query: "modelServiceCatalog", provider: "local" });
	const candidates = (await catalog()).candidates;
	expect(candidates).toEqual([{ id: "remote", contextWindow: 32768, input: ["text", "image"] }, { id: "remote:high" }, { id: "second" }]);
	expect(String(fetch.mock.calls[0]?.[0])).toBe("http://localhost:8080/v1/models");
	expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe("Bearer local");
	const runtime = client.runtime.services.modelRuntime;
	expect(runtime.getModels("local").map(({ id }) => id)).toEqual(["model"]);
	const document = await client.query({ query: "modelServices" });
	const content = editModelsDocument(document.content, ["providers", "local", "models", 1], candidates[0]);
	await client.dispatch({ action: "saveModelServices", original: document.content, content });
	expect(await catalog()).toMatchObject({ candidates, reloadRequired: true, error: "" });
	expect(fetch).toHaveBeenCalledTimes(2);
	const second = editModelsDocument(content, ["providers", "local", "models", 2], candidates[2]);
	await client.dispatch({ action: "saveModelServices", original: content, content: second });
	expect(await catalog()).toMatchObject({ candidates, reloadRequired: true, error: "" });
	expect(runtime.getModels("local").map(({ id }) => id)).toEqual(["model"]);
	await client.dispatch({ action: "reload" });
	expect(runtime.getModel("local", "second")).toBeDefined();
	expect(runtime.getModel("local", "remote")).toMatchObject({ contextWindow: 32768, reasoning: false });
	expect(runtime.getModel("local", "remote:high")).toBeUndefined();
	expect((await catalog()).candidates).toEqual(candidates);
	const removed = editModelsDocument(second, ["providers", "local", "models", 1], undefined);
	await client.dispatch({ action: "saveModelServices", original: second, content: removed });
	expect(await catalog()).toMatchObject({ candidates, reloadRequired: true, error: "" });
	await client.dispatch({ action: "reload" });
	expect((await catalog()).candidates).toEqual(candidates);
	expect(runtime.getModel("local", "remote")).toBeUndefined();
});

it("待重载时查询仍使用会话的地址和认证，重载后才切换连接", async () => {
	await startSession(provider);
	const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: [{ id: "remote" }] }));
	const document = await client.query({ query: "modelServices" });
	let content = editModelsDocument(document.content, ["providers", "local", "baseUrl"], "https://new.test/v1");
	content = editModelsDocument(content, ["providers", "local", "apiKey"], "new-key");
	await client.dispatch({ action: "saveModelServices", original: document.content, content });
	const query = { query: "modelServiceCatalog", provider: "local" } as const;
	expect(await client.query(query)).toMatchObject({ candidates: [{ id: "remote" }], reloadRequired: true, error: "" });
	expect(String(fetch.mock.calls[0]?.[0])).toBe("http://localhost:8080/v1/models");
	expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe("Bearer local");
	fetch.mockResolvedValue(Response.json({ data: [{ id: "new-remote" }] }));
	await client.dispatch({ action: "reload" });
	expect(await client.query(query)).toMatchObject({ candidates: [{ id: "new-remote" }], reloadRequired: false, error: "" });
	expect(String(fetch.mock.calls[1]?.[0])).toBe("https://new.test/v1/models");
	expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get("Authorization")).toBe("Bearer new-key");
});

it("尚未加载的新服务明确提示初始化连接，不影响已有服务查询", async () => {
	await startSession(provider);
	const document = await client.query({ query: "modelServices" });
	const content = editModelsDocument(document.content, ["providers", "new"], { ...provider, models: [] });
	await client.dispatch({ action: "saveModelServices", original: document.content, content });
	const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ data: [{ id: "remote" }] }));
	expect(await client.query({ query: "modelServiceCatalog", provider: "new" })).toMatchObject({
		candidates: [], reloadRequired: true, error: "请先保存并重载新服务，再获取候选模型",
	});
	expect(fetch).not.toHaveBeenCalled();
	expect(await client.query({ query: "modelServiceCatalog", provider: "local" })).toMatchObject({ candidates: [{ id: "remote" }], error: "" });
	await client.dispatch({ action: "reload" });
	expect(await client.query({ query: "modelServiceCatalog", provider: "new" })).toMatchObject({ candidates: [{ id: "remote" }], reloadRequired: false, error: "" });
});

it("候选获取失败或返回空列表不影响已配置模型和保存", async () => {
	await startSession(provider);
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("sk-secret"))
		.mockResolvedValueOnce(Response.json({ data: [] }));
	const query = { query: "modelServiceCatalog", provider: "local" } as const;
	const failed = await client.query(query);
	expect(failed.error).toContain("可重试或手动填写");
	expect(failed.error).not.toContain("sk-secret");
	expect(await client.query(query)).toMatchObject({ candidates: [], error: "" });
	expect(fetch).toHaveBeenCalledTimes(2);
	expect(client.runtime.services.modelRuntime.getModels("local").map(({ id }) => id)).toEqual(["model"]);
});

it("静态服务保存后提示重载，重载更新当前模型", async () => {
	await startSession(provider);
	vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: [] }));
	const document = await client.query({ query: "modelServices" });
	const content = editModelsDocument(document.content, ["providers", "local", "models", 0, "maxTokens"], 2048);
	await client.dispatch({ action: "saveModelServices", original: document.content, content });
	expect(await client.query({ query: "modelServiceCatalog", provider: "local" })).toMatchObject({ reloadRequired: true });
	await client.dispatch({ action: "reload" });
	expect(await client.query({ query: "modelServiceCatalog", provider: "local" })).toMatchObject({ reloadRequired: false });
	expect(client.runtime.services.modelRuntime.getModel("local", "model")?.maxTokens).toBe(2048);
	expect(client.runtime.session.model?.maxTokens).toBe(2048);
});
