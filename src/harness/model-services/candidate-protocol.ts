import type { ModelAuth } from "@earendil-works/pi-ai";
import { configObject } from "./document.ts";
import type { ModelCandidate } from "./model-candidates.ts";

export type CatalogProtocol = "openai" | "anthropic" | "google";

export function catalogProtocol(api: string | undefined): CatalogProtocol | undefined {
	switch (api) {
		case "openai-completions": case "openai-responses": case "mistral-conversations": return "openai";
		case "anthropic-messages": return "anthropic";
		case "google-generative-ai": return "google";
	}
}

export function catalogUrl(protocol: CatalogProtocol, baseUrl: string): URL {
	const url = new URL(baseUrl);
	let path = url.pathname.replace(/\/$/, "");
	if (protocol === "anthropic" && !path.endsWith("/v1")) path += "/v1";
	// Google 与 Pi 的适配器一致，baseUrl 包含 API 版本路径。
	url.pathname = `${path}/models`;
	return url;
}

export function catalogHeaders(protocol: CatalogProtocol, auth: ModelAuth): Headers {
	const headers = new Headers({ Accept: "application/json" });
	if (protocol === "anthropic") headers.set("anthropic-version", "2023-06-01");
	if (auth.apiKey !== undefined) {
		if (protocol === "anthropic" && auth.apiKey.includes("sk-ant-oat")) {
			headers.set("Authorization", `Bearer ${auth.apiKey}`);
			headers.set("anthropic-beta", "oauth-2025-04-20");
		} else if (protocol === "anthropic") headers.set("x-api-key", auth.apiKey);
		else if (protocol === "google") headers.set("x-goog-api-key", auth.apiKey);
		else headers.set("Authorization", `Bearer ${auth.apiKey}`);
	}
	// OAuth 与自定义认证由 SDK 解析，允许覆盖或删除协议默认请求头。
	for (const [key, value] of Object.entries(auth.headers ?? {})) {
		if (value === null) headers.delete(key);
		else headers.set(key, value);
	}
	return headers;
}

export function parseCandidatePage(protocol: CatalogProtocol, payload: unknown): { candidates: ModelCandidate[]; cursor?: string } {
	if (!configObject(payload)) throw new Error("模型列表不是对象");
	const entries = protocol === "google" ? payload.models : payload.data;
	if (!Array.isArray(entries)) throw new Error("模型列表缺少数组");
	const candidates: ModelCandidate[] = [];
	for (const entry of entries) {
		if (!configObject(entry)) throw new Error("模型不是对象");
		const rawId = protocol === "google" ? entry.name : entry.id;
		if (typeof rawId !== "string") throw new Error("模型 ID 为空");
		const id = protocol === "google" ? rawId.replace(/^models\//, "") : rawId;
		if (!id.trim()) throw new Error("模型 ID 为空");
		// Gemini 的列表也包含 embedding 等模型，只提供可用于聊天的候选。
		if (protocol === "google" && Array.isArray(entry.supportedGenerationMethods)
			&& !entry.supportedGenerationMethods.includes("generateContent")) continue;
		const candidate: ModelCandidate = { id };
		const context = protocol === "google" ? entry.inputTokenLimit : entry.context_length;
		if (typeof context === "number" && Number.isFinite(context) && context > 0) candidate.contextWindow = context;
		if (configObject(entry.architecture) && Array.isArray(entry.architecture.input_modalities) && entry.architecture.input_modalities.includes("image"))
			candidate.input = ["text", "image"];
		candidates.push(candidate);
	}
	const next = protocol === "google" ? payload.nextPageToken : payload.has_more === true ? payload.last_id : undefined;
	if (next !== undefined && (typeof next !== "string" || !next)) throw new Error("无效分页游标");
	if (protocol !== "google" && payload.has_more === true && next === undefined) throw new Error("缺少分页游标");
	return { candidates, ...(typeof next === "string" ? { cursor: next } : {}) };
}
