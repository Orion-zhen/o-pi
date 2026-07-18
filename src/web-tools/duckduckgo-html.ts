import type { Dispatcher } from "undici";
import { Parser } from "htmlparser2";

import { classifyNetworkError } from "./http-client.js";
import { readLimitedResponseBody, responseContentLength } from "./response-body.js";
import type { WebHttpFetch, WebHttpResponse, WebSearchFailureDetails, WebSearchItem, WebToolsConfig } from "./types.js";
import {
	normalizeSearchResultUrl,
	normalizeSearchText,
	SEARCH_RESULT_MAX_SNIPPET_CHARS,
	SEARCH_RESULT_MAX_TITLE_CHARS,
} from "./url-utils.js";

export { normalizeSearchText } from "./url-utils.js";

export const SEARCH_ENDPOINT = new URL("https://html.duckduckgo.com/html/");

const CHALLENGE_MARKERS = ["anomaly-modal", "anomaly.js", "challenge-form", "Unfortunately, bots use DuckDuckGo too"];

/** DDG 后端返回原始搜索结果或已映射的搜索失败 details。 */
export type DuckDuckGoHtmlResult =
	| {
			status: "success";
			results: WebSearchItem[];
			downloadedBytes: number;
	  }
	| {
			status: "failed";
			details: WebSearchFailureDetails;
	  };

/** DDG HTML 请求所需运行时依赖；不包含 Cookie 或用户指定 host。 */
export interface DuckDuckGoHtmlOptions {
	query: string;
	limit: number;
	config: WebToolsConfig["websearch"]["duckduckgo_html"];
	dispatcher: Dispatcher;
	fetchImpl: WebHttpFetch;
	signal: AbortSignal;
	userSignal?: AbortSignal;
	onDownloading?: (receivedBytes: number, expectedBytes?: number) => void;
	onParsing?: () => void;
}

/** 执行固定 DDG HTML 搜索；不跟随重定向、不读取搜索结果页面。 */
export async function searchDuckDuckGoHtml(options: DuckDuckGoHtmlOptions): Promise<DuckDuckGoHtmlResult> {
	const form = new URLSearchParams({
		q: options.query,
		kl: options.config.region,
		b: "",
	});
	const searchUrl = new URL(SEARCH_ENDPOINT);
	searchUrl.search = form.toString();

	let response: WebHttpResponse;
	try {
		response = await options.fetchImpl(searchUrl, {
			method: "GET",
			redirect: "manual",
			dispatcher: options.dispatcher,
			signal: options.signal,
			headers: {
				"User-Agent": options.config.user_agent,
				Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
				Referer: "https://html.duckduckgo.com/",
			},
		});
	} catch (error) {
		return {
			status: "failed",
			details: failure(networkCodeForSearch(error, options.userSignal), errorMessage(error), options.query),
		};
	}

	const expected = responseContentLength(response.headers);
	const body = await readLimitedResponseBody(response, {
		maxBytes: options.config.response_bytes,
		...(options.userSignal !== undefined ? { signal: options.userSignal } : {}),
		onProgress(receivedBytes) {
			options.onDownloading?.(receivedBytes, expected);
		},
	});
	if (body.status === "failed") {
		return {
			status: "failed",
			details: failure(body.code, body.message, options.query, response.status),
		};
	}

	const html = new TextDecoder("utf-8", { fatal: false }).decode(body.bytes);
	options.onParsing?.();
	const preview = previewHtml(html);
	if (response.status === 429 || isChallengeHtml(html)) {
		return {
			status: "failed",
			details: failure("PROVIDER_BLOCKED", "DuckDuckGo blocked the automated search request.", options.query, response.status),
		};
	}
	if (response.status < 200 || response.status >= 300) {
		return {
			status: "failed",
			details: { ...failure("HTTP_ERROR", `${response.status} ${response.statusText || "HTTP error"}`, options.query, response.status), response_preview: preview },
		};
	}
	if (!isHtmlResponse(response)) {
		return {
			status: "failed",
			details: failure("UNSUPPORTED_CONTENT_TYPE", "search response is not text/html.", options.query, response.status),
		};
	}

	const parsed = parseDuckDuckGoHtml(html, options.limit);
	if (parsed.status === "failed") {
		const details = failure(parsed.code, parsed.message, options.query, response.status);
		if (parsed.code === "PARSE_FAILED") details.response_preview = preview;
		return {
			status: "failed",
			details,
		};
	}
	return {
		status: "success",
		results: parsed.results,
		downloadedBytes: body.bytes.byteLength,
	};
}

/** DDG HTML parser 的结构化结果，用于工具层和 parser 单测。 */
export type DuckDuckGoParseResult =
	| {
			status: "success";
			results: WebSearchItem[];
	  }
	| {
			status: "failed";
			code: "PROVIDER_BLOCKED" | "PARSE_FAILED";
			message: string;
	  };

/** 解析 DDG HTML 结果页；只抽取标题、URL 和摘要。 */
export function parseDuckDuckGoHtml(html: string, limit = 20): DuckDuckGoParseResult {
	if (isChallengeHtml(html)) {
		return { status: "failed", code: "PROVIDER_BLOCKED", message: "DuckDuckGo blocked the automated search request." };
	}

	const parsed = parseResultBlocks(html);
	const seen = new Set<string>();
	const results: WebSearchItem[] = [];
	for (const block of parsed.blocks) {
		if (block.ad) continue;
		const title = normalizeSearchText(block.title).slice(0, SEARCH_RESULT_MAX_TITLE_CHARS);
		if (title.length === 0) continue;
		if (block.href === undefined) continue;
		const url = unwrapDuckDuckGoUrl(block.href);
		if (url === undefined || url.username !== "" || url.password !== "") continue;
		const normalizedUrl = url.toString();
		if (seen.has(normalizedUrl)) continue;
		seen.add(normalizedUrl);
		const snippet = normalizeSearchText(block.snippet).slice(0, SEARCH_RESULT_MAX_SNIPPET_CHARS);
		results.push({
			rank: results.length + 1,
			title,
			url: normalizedUrl,
			...(snippet.length > 0 ? { snippet } : {}),
		});
		if (results.length >= limit) break;
	}

	if (results.length > 0) return { status: "success", results };
	if (parsed.hasNoResultsMarker || hasNoResultsText(parsed.pageText)) return { status: "success", results: [] };
	return { status: "failed", code: "PARSE_FAILED", message: "DuckDuckGo HTML search results could not be parsed." };
}

interface ParsedResultBlock {
	ad: boolean;
	href?: string;
	title: string;
	snippet: string;
}

interface ActiveResultBlock {
	ad: boolean;
	depth: number;
	href: string | undefined;
	title: string;
	titleDepth: number | undefined;
	snippet: string;
	snippetDepth: number | undefined;
}

function parseResultBlocks(html: string): { blocks: ParsedResultBlock[]; hasNoResultsMarker: boolean; pageText: string } {
	const blocks: ParsedResultBlock[] = [];
	const pageText: string[] = [];
	let current: ActiveResultBlock | undefined;
	let hasNoResultsMarker = false;
	const parser = new Parser({
		onopentag(_name, attributes) {
			const classes = classNames(attributes["class"]);
			if (classes.has("no-results") || classes.has("results--message")) hasNoResultsMarker = true;
			if (current === undefined) {
				if (!classes.has("result")) return;
				current = {
					ad: classes.has("result--ad"),
					href: undefined,
					title: "",
					snippet: "",
					depth: 1,
					titleDepth: undefined,
					snippetDepth: undefined,
				};
				return;
			}
			current.depth += 1;
			if (classes.has("badge--ad")) current.ad = true;
			if (current.titleDepth === undefined && classes.has("result__a")) {
				current.titleDepth = current.depth;
				current.href = attributes["href"];
			}
			if (current.snippetDepth === undefined && classes.has("result__snippet")) current.snippetDepth = current.depth;
		},
		ontext(text) {
			pageText.push(text);
			if (current?.titleDepth !== undefined) current.title += text;
			if (current?.snippetDepth !== undefined) current.snippet += text;
		},
		onclosetag() {
			if (current === undefined) return;
			if (current.titleDepth === current.depth) current.titleDepth = undefined;
			if (current.snippetDepth === current.depth) current.snippetDepth = undefined;
			if (current.depth === 1) {
				blocks.push({
					ad: current.ad,
					...(current.href !== undefined ? { href: current.href } : {}),
					title: current.title,
					snippet: current.snippet,
				});
				current = undefined;
				return;
			}
			current.depth -= 1;
		},
	}, { decodeEntities: true });
	parser.end(html);
	return { blocks, hasNoResultsMarker, pageText: pageText.join("") };
}

function classNames(value: string | undefined): Set<string> {
	return new Set(value?.split(/\s+/).filter(Boolean) ?? []);
}

export function unwrapDuckDuckGoUrl(href: string): URL | undefined {
	let url: URL;
	try {
		url = new URL(href, SEARCH_ENDPOINT);
	} catch {
		return undefined;
	}

	if ((url.hostname === "duckduckgo.com" || url.hostname.endsWith(".duckduckgo.com")) && url.pathname === "/l/") {
		const target = url.searchParams.get("uddg");
		if (target === null || target.length === 0) return undefined;
		try {
			url = new URL(target);
		} catch {
			return undefined;
		}
	}
	return normalizeSearchResultUrl(url, { allowUserinfo: true });
}

function isChallengeHtml(html: string): boolean {
	return CHALLENGE_MARKERS.some((marker) => html.includes(marker));
}

function hasNoResultsText(pageText: string): boolean {
	const text = normalizeSearchText(pageText).toLowerCase();
	return text.includes("no results found") || text.includes("not many results contain");
}

function isHtmlResponse(response: WebHttpResponse): boolean {
	const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
	return contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
}

function failure(
	code: WebSearchFailureDetails["error"]["code"],
	message: string,
	query: string,
	httpStatus?: number,
): WebSearchFailureDetails {
	return {
		status: "failed",
		error: { code, message },
		query,
		provider: "duckduckgo_html",
		...(httpStatus !== undefined ? { http_status: httpStatus } : {}),
	};
}

function networkCodeForSearch(error: unknown, userSignal: AbortSignal | undefined): WebSearchFailureDetails["error"]["code"] {
	const code = classifyNetworkError(error, userSignal);
	return code === "BLOCKED_ADDRESS" ? "CONNECTION_FAILED" : code;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function previewHtml(html: string): string {
	const text = normalizeSearchText(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]*>/g, " "));
	return text.slice(0, 500);
}
