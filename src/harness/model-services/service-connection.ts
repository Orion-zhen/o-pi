import { configObject, type ConfigObject } from "./document.ts";

export const serviceConnectionTimeoutMs = 8_000;

export interface ServiceConnectionCheck {
	status: "connected" | "catalog" | "auth-failed" | "network-error" | "timeout" | "server-error" | "rate-limited" | "unsupported" | "invalid-response" | "http-error";
	httpStatus: number | null;
	checkedAt: number;
	latencyMs: number;
}

/** 仅在内存中比较连接配置，不把含凭据的比较值传给客户端或写入日志。 */
export function serviceConnectionKey(config: ConfigObject | undefined): string {
	if (!config) return "";
	const headers = configObject(config.headers) ? Object.entries(config.headers).sort(([a], [b]) => a.localeCompare(b)) : config.headers;
	const modelConnections = Array.isArray(config.models) ? config.models.filter(configObject)
		.filter((model) => model.api !== undefined || model.baseUrl !== undefined)
		.map((model) => [model.id, model.api, model.baseUrl]) : [];
	return JSON.stringify([config.api, config.baseUrl, config.apiKey, config.oauth, config.authHeader ?? false, headers ?? [], modelConnections]);
}
