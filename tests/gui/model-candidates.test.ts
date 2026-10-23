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
	expect(await query()).toMatchObject({ candidates: [{ id: "m" }], connection: { status: "connected", httpStatus: 200 } });
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
	expect(await fetchModelCandidates(runtime, "local", "https://models.test/v1", new AbortController().signal)).toMatchObject({
		candidates: [], connection: { status: "invalid-response", httpStatus: 200 },
	});
	expect(runtime.getModels("local")).toEqual([]);
});

it.each([
	[401, "auth-failed"], [404, "unsupported"], [429, "rate-limited"], [503, "server-error"], [400, "http-error"],
] as const)("HTTP %s 返回安全的连通性状态 %s，不读取错误正文", async (httpStatus, status) => {
	const { runtime } = await setup();
	const response = new Response("sk-secret upstream details", { status: httpStatus });
	vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
	const result = await fetchModelCandidates(runtime, "local", "https://models.test/v1", new AbortController().signal);
	expect(result).toMatchObject({ candidates: [], connection: { status, httpStatus, checkedAt: expect.any(Number), latencyMs: expect.any(Number) } });
	expect(JSON.stringify(result)).not.toContain("sk-secret");
	expect(response.bodyUsed).toBe(true);
});

it("空模型列表也表示已连接，HTML 页面不能确认连接", async () => {
	const { runtime } = await setup();
	vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ data: [] })).mockResolvedValueOnce(new Response("<html>login</html>"));
	const query = () => fetchModelCandidates(runtime, "local", "https://models.test/v1", new AbortController().signal);
	expect(await query()).toMatchObject({ candidates: [], connection: { status: "connected" } });
	expect(await query()).toMatchObject({ candidates: [], connection: { status: "invalid-response" } });
});

it("探测超时返回超时状态", async () => {
	const { runtime } = await setup();
	const timeout = new AbortController();
	vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => new Promise<Response>((_resolve, reject) => {
		const signal = init?.signal;
		if (!signal) throw new Error("缺少超时信号");
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		timeout.abort(new DOMException("timeout", "TimeoutError"));
	}));
	expect(await fetchModelCandidates(runtime, "local", "https://models.test/v1", new AbortController().signal)).toMatchObject({
		candidates: [], connection: { status: "timeout", httpStatus: null },
	});
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
