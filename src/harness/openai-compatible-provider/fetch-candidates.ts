import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { configObject } from "./document.ts";
import type { ModelCandidate } from "./model-candidates.ts";

/** 只读取候选，不注册模型或写入配置、目录缓存。 */
export async function fetchModelCandidates(models: ModelRuntime, id: string, baseUrl: string, signal: AbortSignal): Promise<ModelCandidate[]> {
	const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
	const resolved = await models.getAuth(id, { signal: requestSignal });
	if (!resolved) throw new Error("未配置认证");
	const { auth } = resolved;
	const headers = new Headers({ Accept: "application/json" });
	if (auth.apiKey !== undefined) headers.set("Authorization", `Bearer ${auth.apiKey}`);
	for (const [key, value] of Object.entries(auth.headers ?? {})) {
		if (value === null) headers.delete(key);
		else headers.set(key, value);
	}
	const address = auth.baseUrl ?? baseUrl;
	const url = new URL("models", address.endsWith("/") ? address : `${address}/`);
	const response = await fetch(url, { headers, signal: requestSignal });
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`HTTP ${response.status}`);
	}
	const payload: unknown = await response.json();
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
