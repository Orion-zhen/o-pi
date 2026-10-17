import { writeFile } from "node:fs/promises";
import path from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { fetchModelCandidates } from "../../src/harness/openai-compatible-provider/fetch-candidates.ts";
import { deferred } from "../helpers/async.ts";
import { useTempDir } from "../helpers/lifecycle.ts";

const temp = useTempDir("opi-model-candidates-");
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function setup(config: Record<string, unknown> = {}) {
	const modelsPath = path.join(temp.path, "models.json");
	await writeFile(modelsPath, JSON.stringify({ providers: { local: {
		baseUrl: "https://models.test/v1", api: "openai-completions", apiKey: "configured", ...config,
	} } }));
	const credentials = new InMemoryCredentialStore();
	const runtime = await ModelRuntime.create({ modelsPath, credentials, modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
	return { runtime, credentials };
}

it("无模型定义也能读取候选，认证使用 SDK 的存储及会话密钥优先级", async () => {
	vi.stubEnv("TOKEN", "header-token");
	const { runtime, credentials } = await setup({ headers: { "X-Token": "$TOKEN" } });
	await credentials.modify("local", async () => ({ type: "api_key", key: "stored" }));
	const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ data: [{ id: "m" }] }));
	const query = () => fetchModelCandidates(runtime, "local", "https://models.test/v1", new AbortController().signal);
	expect(await query()).toEqual([{ id: "m" }]);
	expect(Object.fromEntries(new Headers(fetch.mock.calls[0]?.[1]?.headers))).toEqual({ accept: "application/json", authorization: "Bearer stored", "x-token": "header-token" });
	await runtime.setRuntimeApiKey("local", "session-key");
	await query();
	expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get("Authorization")).toBe("Bearer session-key");
	expect(runtime.getModels("local")).toEqual([]);
});

it("候选请求通过 SDK 每次解析 provider 请求头，保留显式 Authorization", async () => {
	const token = path.join(temp.path, "token");
	const command = path.join(temp.path, "header.cjs");
	await writeFile(command, `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(token)}, "utf8"));`);
	const { runtime } = await setup({ headers: { Authorization: "Custom auth", "X-Token": `!"${process.execPath}" "${command}"` } });
	const headers: Headers[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
		headers.push(new Headers(init?.headers));
		return Response.json({ data: [] });
	});
	for (const value of ["first", "second"]) {
		await writeFile(token, value);
		await fetchModelCandidates(runtime, "local", "https://models.test/v1/", new AbortController().signal);
	}
	expect(headers.map((value) => value.get("X-Token"))).toEqual(["first", "second"]);
	expect(headers.map((value) => value.get("Authorization"))).toEqual(["Custom auth", "Custom auth"]);
});

it.each([
	{ models: [] }, { data: [{}] }, { data: [{ id: " " }] }, { data: [{ id: "m" }, { id: "m" }] },
])("拒绝无法用作添加候选的响应 %j", async (payload) => {
	const { runtime } = await setup();
	vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(payload));
	await expect(fetchModelCandidates(runtime, "local", "https://models.test/v1", new AbortController().signal)).rejects.toThrow();
	expect(runtime.getModels("local")).toEqual([]);
});

it("会话取消中止候选网络请求", async () => {
	const { runtime } = await setup();
	const started = deferred<void>();
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => new Promise<Response>((_resolve, reject) => {
		const signal = init?.signal;
		if (!signal) throw new Error("缺少取消信号");
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		started.resolve();
	}));
	const controller = new AbortController();
	const request = fetchModelCandidates(runtime, "local", "https://models.test/v1", controller.signal);
	await started.promise;
	controller.abort();
	await expect(request).rejects.toThrow();
});
