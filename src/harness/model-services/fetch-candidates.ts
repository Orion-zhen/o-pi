import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProviderConfig } from "./schema.ts";
import type { ModelCandidate } from "./model-candidates.ts";
import { catalogHeaders, catalogProtocol, catalogUrl, parseCandidatePage } from "./candidate-protocol.ts";
import { serviceConnectionTimeoutMs, type ServiceConnectionCheck } from "./service-connection.ts";

function httpFailure(status: number): ServiceConnectionCheck["status"] {
	if (status === 401 || status === 403) return "auth-failed";
	if (status === 404 || status === 405) return "unsupported";
	if (status === 429) return "rate-limited";
	if (status >= 500) return "server-error";
	return "http-error";
}

/** 通用列表协议直接查询服务。其他协议使用 SDK 目录，不将目录可用误报为连接成功。 */
export async function fetchModelCandidates(models: ModelRuntime, id: string, config: ProviderConfig, signal: AbortSignal): Promise<{
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
	signal.throwIfAborted();
	const provider = models.getProvider(id);
	// 未声明 provider 级协议时，只从无歧义的模型连接继承，不猜测混合 API。
	const catalog = models.getModels(id);
	const first = catalog[0];
	const inherited = first && catalog.every((model) => model.api === first.api && model.baseUrl === first.baseUrl) ? first : undefined;
	const api = config.api ?? inherited?.api;
	const address = config.baseUrl ?? provider?.baseUrl ?? inherited?.baseUrl;
	const protocol = catalogProtocol(api);
	if (!protocol || !address) {
		// ModelRuntime.refresh 会重载配置，候选查询只读取当前会话目录。
		const candidates = catalog.map(({ id, contextWindow, input }) => ({ id, contextWindow, input }));
		return result(candidates.length ? "catalog" : "unsupported", candidates);
	}
	try {
		requestSignal.throwIfAborted();
		const resolved = await models.getAuth(id, { signal: requestSignal });
		if (!resolved) return result("auth-failed");
		const headers = catalogHeaders(protocol, resolved.auth);
		const url = catalogUrl(protocol, resolved.auth.baseUrl ?? address);
		const candidates: ModelCandidate[] = [];
		const ids = new Set<string>();
		const cursors = new Set<string>();
		do {
			requestSignal.throwIfAborted();
			failure = "network-error";
			const response = await fetch(url, { headers, signal: requestSignal });
			httpStatus = response.status;
			if (!response.ok) {
				await response.body?.cancel();
				return result(httpFailure(response.status));
			}
			failure = "invalid-response";
			const page = parseCandidatePage(protocol, await response.json());
			for (const candidate of page.candidates) {
				if (ids.has(candidate.id)) throw new Error("重复模型 ID");
				ids.add(candidate.id);
				candidates.push(candidate);
			}
			if (!page.cursor) return result("connected", candidates);
			if (cursors.has(page.cursor)) throw new Error("重复分页游标");
			cursors.add(page.cursor);
			url.searchParams.set(protocol === "google" ? "pageToken" : "after_id", page.cursor);
		} while (true);
	} catch {
		signal.throwIfAborted();
		// 认证命令和上游错误可能含密钥，只返回失败分类和 HTTP 状态码。
		return result(requestSignal.aborted ? "timeout" : failure);
	}
}
