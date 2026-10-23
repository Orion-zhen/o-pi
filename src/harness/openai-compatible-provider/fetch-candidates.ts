import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { configObject } from "./document.ts";
import type { ModelCandidate } from "./model-candidates.ts";
import { serviceConnectionTimeoutMs, type ServiceConnectionCheck } from "./service-connection.ts";

function parseCandidates(payload: unknown): ModelCandidate[] {
	if (!configObject(payload) || !Array.isArray(payload.data)) throw new Error("模型列表缺少 data 数组");
	const ids = new Set<string>();
	return payload.data.map((entry: unknown): ModelCandidate => {
		if (!configObject(entry) || typeof entry.id !== "string" || !entry.id.trim() || ids.has(entry.id))
			throw new Error("模型 ID 为空或重复");
		ids.add(entry.id);
		const candidate: ModelCandidate = { id: entry.id };
		if (typeof entry.context_length === "number" && Number.isFinite(entry.context_length) && entry.context_length > 0)
			candidate.contextWindow = entry.context_length;
		if (configObject(entry.architecture) && Array.isArray(entry.architecture.input_modalities) && entry.architecture.input_modalities.includes("image"))
			candidate.input = ["text", "image"];
		return candidate;
	});
}

function httpFailure(status: number): ServiceConnectionCheck["status"] {
	if (status === 401 || status === 403) return "auth-failed";
	if (status === 404 || status === 405) return "unsupported";
	if (status === 429) return "rate-limited";
	if (status >= 500) return "server-error";
	return "http-error";
}

/** 同一次请求读取候选并检测连接，不注册模型或写入配置、目录缓存。 */
export async function fetchModelCandidates(models: ModelRuntime, id: string, baseUrl: string, signal: AbortSignal): Promise<{
	candidates: ModelCandidate[];
	connection: ServiceConnectionCheck;
}> {
	const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(serviceConnectionTimeoutMs)]);
	const started = performance.now();
	let httpStatus: number | null = null;
	let failure: ServiceConnectionCheck["status"] = "auth-failed";
	const result = (status: ServiceConnectionCheck["status"], candidates: ModelCandidate[] = []) => ({
		candidates, connection: { status, httpStatus, checkedAt: Date.now(), latencyMs: Math.round(performance.now() - started) },
	});
	try {
		requestSignal.throwIfAborted();
		const resolved = await models.getAuth(id, { signal: requestSignal });
		if (!resolved) return result("auth-failed");
		const { auth } = resolved;
		const headers = new Headers({ Accept: "application/json" });
		if (auth.apiKey !== undefined) headers.set("Authorization", `Bearer ${auth.apiKey}`);
		for (const [key, value] of Object.entries(auth.headers ?? {})) {
			if (value === null) headers.delete(key);
			else headers.set(key, value);
		}
		failure = "network-error";
		const address = auth.baseUrl ?? baseUrl;
		const url = new URL("models", address.endsWith("/") ? address : `${address}/`);
		const response = await fetch(url, { headers, signal: requestSignal });
		httpStatus = response.status;
		if (!response.ok) {
			await response.body?.cancel();
			return result(httpFailure(response.status));
		}
		failure = "invalid-response";
		return result("connected", parseCandidates(await response.json()));
	} catch {
		signal.throwIfAborted();
		// 认证命令和上游错误可能含密钥，只返回失败分类和 HTTP 状态码。
		return result(requestSignal.aborted ? "timeout" : failure);
	}
}
