import type { WebSearchErrorCode, WebSearchItem, WebSearchProviderId } from "../core/types.ts";
import { normalizeSearchResultUrl, normalizeSearchText, stripTerminalControls } from "../network/url-utils.ts";
import type { SearchProviderFailure, SearchProviderResult } from "./types.ts";

export function normalizeProviderResponse(id: WebSearchProviderId, raw: unknown, downloadedBytes: number): SearchProviderResult {
	if (!record(raw)) {
		return searchFailure("PARSE_FAILED", id === "exa_mcp" ? "exa_mcp returned an invalid search response." : `${id} response is not an object.`);
	}
	const rows = responseRows(id, raw);
	if (rows === undefined) return searchFailure("PARSE_FAILED", `${id} returned an invalid search response.`);
	const results: WebSearchItem[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		if (!record(row)) continue;
		const rawUrl = string(row["url"]);
		const url = rawUrl === undefined ? undefined : normalizeSearchResultUrl(rawUrl)?.toString();
		if (url === undefined || seen.has(url)) continue;
		seen.add(url);
		const title = normalizeSearchText(string(row["title"]) ?? url) || url;
		// 保留全部非空片段及代码排版，只清理终端控制字符和完全重复的片段。
		const snippets = snippetCandidates(id, row)
			.filter((value): value is string => typeof value === "string")
			.map((value) => stripTerminalControls(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ""))
			.filter((value) => value.trim().length > 0);
		const snippet = [...new Set(snippets)].join("\n\n");
		results.push({ title, url, ...(snippet ? { snippet } : {}) });
	}
	return { status: "success", results, downloadedBytes };
}

function responseRows(id: WebSearchProviderId, raw: Record<string, unknown>): unknown[] | undefined {
	switch (id) {
		case "brave_api": {
			const grounding = raw["grounding"];
			if (!record(grounding)) return [];
			return [...array(grounding["generic"]), ...(record(grounding["poi"]) ? [grounding["poi"]] : []), ...array(grounding["map"])];
		}
		case "anysearch": {
			const data = raw["data"];
			return raw["code"] === 0 && record(data) && Array.isArray(data["results"]) ? data["results"] : undefined;
		}
		case "exa_mcp":
			return Array.isArray(raw["results"]) ? raw["results"] : undefined;
		default:
			return array(raw["results"]);
	}
}

function snippetCandidates(id: WebSearchProviderId, row: Record<string, unknown>): unknown[] {
	switch (id) {
		case "brave_api": return array(row["snippets"]);
		case "anysearch": return [row["content"], row["snippet"]];
		case "tavily": return [row["content"], ...array(row["highlights"])];
		case "tinyfish": return [row["snippet"], ...array(row["highlights"])];
		case "exa_api": return [row["description"], ...array(row["highlights"])];
		case "exa_mcp": return [row["description"], ...array(row["highlights"]), row["text"]];
	}
}

export function classifyHttpStatus(status: number, body: string): SearchProviderFailure["error"] {
	const lower = body.toLowerCase();
	if (status === 429) return { code: "RATE_LIMITED", message: "search provider rate limit exceeded." };
	if (status === 402 || lower.includes("quota") || lower.includes("credit") && lower.includes("exhaust")) return { code: "QUOTA_EXHAUSTED", message: "search provider quota exhausted." };
	if (status === 401 || status === 403) return { code: "CONFIG_ERROR", message: `search provider rejected credentials (${status}).` };
	if (status === 400 || status === 422) return { code: "INVALID_ARGUMENT", message: `search provider rejected the search request (${status}).` };
	if (status >= 300 && status < 400 || status === 404 || status === 405) return { code: "CONFIG_ERROR", message: `search provider endpoint is misconfigured (${status}).` };
	return { code: "HTTP_ERROR", message: `${status} search provider HTTP error.` };
}

export function searchFailure(code: WebSearchErrorCode, message: string, httpStatus?: number): SearchProviderFailure {
	return { status: "failed", error: { code, message }, ...(httpStatus === undefined ? {} : { http_status: httpStatus }) };
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function string(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value : undefined; }
