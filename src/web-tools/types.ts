import type { Dispatcher } from "undici";

import type { PageAnalysis } from "./html-page-analyzer.js";

export type WebFetchMode = "readable" | "source";
export type WebFetchOutputFormat = "markdown" | "text" | "json" | "xml" | "image" | "source";
export type WebFetchPageKind = "article" | "image" | "video" | "audio" | "generic";
export type WebFetchTextSource = "readability" | "semantic" | "heading" | "body" | "metadata";
export type SnapshotStatus = "created" | "hit" | "refetched" | "not_needed";
/** 搜索运行时 provider 标识；不暴露为模型工具参数。 */
export type FormalWebSearchProviderId = "brave_api" | "exa_api" | "tavily";
export type WebSearchProviderId = FormalWebSearchProviderId | "duckduckgo_html";

export interface WebFetchParams {
	url: string;
	mode?: WebFetchMode;
	offset?: number;
	limit?: number;
}

/** 公开网页搜索参数；region 是稳定配置，不由模型逐次指定。 */
export interface WebSearchParams {
	query: string;
	limit?: number;
}

/** 单条搜索结果，rank 保留搜索引擎原始排序。 */
export interface WebSearchItem {
	rank: number;
	title: string;
	url: string;
	snippet?: string;
	/** Provider-native relevance; details/telemetry only. */
	score?: number;
	/** Merged provenance; never rendered into model content. */
	provenance?: Array<{ provider: FormalWebSearchProviderId; rank: number }>;
}

export interface WebToolsConfig {
	network: {
		/** 两个 Web 工具共用的安全 DNS fake-ip 放行范围。 */
		fake_ip_ranges: string[];
	};
	websearch: {
		default_results: number;
		cache_ttl_seconds: number;
		negative_cache_ttl_seconds: number;
		total_deadline_seconds: number;
		include_domains: string[];
		exclude_domains: string[];
		brave_api: {
			enabled: boolean;
			endpoint: string;
			api_key: string;
			timeout_seconds: number;
			response_bytes: number;
			extra_snippets: boolean;
		};
		exa_api: {
			enabled: boolean;
			endpoint: string;
			api_key: string;
			timeout_seconds: number;
			response_bytes: number;
			highlight_chars: number;
		};
		tavily: {
			enabled: boolean;
			endpoint: string;
			api_key: string;
			timeout_seconds: number;
			response_bytes: number;
		};
		duckduckgo_html: {
			enabled: boolean;
			timeout_seconds: number;
			user_agent: string;
			region: string;
			response_bytes: number;
			min_interval_seconds: number;
			blocked_cooldown_seconds: number;
		};
	};
	webfetch: {
		timeout_seconds: number;
		max_redirects: number;
		user_agent: string;
		readability: {
			char_threshold: number;
		};
		media: {
			mode: "auto" | "off";
			response_bytes: number;
		};
		limits: {
			response_bytes: number;
			default_output_chars: number;
			max_output_chars: number;
		};
		cookies: {
			enabled: boolean;
			domains: string[];
			confirmation: "always" | "session" | "never";
		};
	};
}

export type WebFetchErrorCode =
	| "INVALID_ARGUMENT"
	| "CONFIG_ERROR"
	| "INVALID_URL"
	| "BLOCKED_ADDRESS"
	| "COOKIE_ERROR"
	| "AUTH_CONFIRMATION_REQUIRED"
	| "DNS_FAILED"
	| "CONNECTION_FAILED"
	| "TLS_FAILED"
	| "TIMEOUT"
	| "ABORTED"
	| "TOO_MANY_REDIRECTS"
	| "HTTP_ERROR"
	| "RESPONSE_TOO_LARGE"
	| "UNSUPPORTED_CONTENT_TYPE"
	| "DECODE_FAILED"
	| "CONVERSION_FAILED"
	| "OFFSET_OUT_OF_RANGE";

/** 搜索工具对模型和 renderer 暴露的稳定错误码。 */
export type WebSearchErrorCode =
	| "INVALID_ARGUMENT"
	| "CONFIG_ERROR"
	| "DNS_FAILED"
	| "CONNECTION_FAILED"
	| "TLS_FAILED"
	| "TIMEOUT"
	| "ABORTED"
	| "HTTP_ERROR"
	| "RESPONSE_TOO_LARGE"
	| "UNSUPPORTED_CONTENT_TYPE"
	| "QUOTA_EXHAUSTED"
	| "RATE_LIMITED"
	| "NO_PROVIDER_AVAILABLE"
	| "PROVIDER_BLOCKED"
	| "PARSE_FAILED";

export interface WebFetchFailureDetails {
	status: "failed";
	error: {
		code: WebFetchErrorCode;
		message: string;
	};
	requested_url?: string;
	final_url?: string;
	http_status?: number;
	authenticated?: boolean;
	redirect_count?: number;
	duration_ms?: number;
	response_preview?: string;
}

export interface WebFetchSuccessDetails {
	status: "success";
	scope: "static_response";
	page_kind: WebFetchPageKind;
	text_source: WebFetchTextSource;
	completeness: "complete" | "partial";
	omissions: WebFetchOmission[];
	requested_url: string;
	final_url: string;
	http_status: number;
	title?: string;
	content_type?: string;
	charset?: string;
	format: WebFetchOutputFormat;
	downloaded_bytes: number;
	total_chars: number;
	range: {
		start: number;
		end: number;
		total: number;
		has_more: boolean;
		next_offset?: number;
	};
	next?: string;
	authenticated: boolean;
	redirect_count: number;
	snapshot: SnapshotStatus;
	deferred_fragments: {
		discovered: number;
		resolved: number;
	};
	media: {
		discovered: number;
		returned: number;
	};
	duration_ms: number;
	/** 供展开 renderer 使用的短预览，不含包装标签。 */
	preview: string;
}

export interface WebFetchOmission {
	kind:
		| "text_range"
		| "deferred_content"
		| "primary_media"
		| "embedded_content"
		| "structured_data"
		| "interactive_content";
	reason:
		| "range"
		| "unresolved_declaration"
		| "model_no_image_input"
		| "api_no_tool_image_output"
		| "media_disabled"
		| "offset_range"
		| "media_fetch_failed"
		| "media_too_large"
		| "unsupported_media_type"
		| "video_not_returned"
		| "audio_not_returned"
		| "iframe_not_fetched"
		| "invalid_or_limited"
		| "client_rendered";
}

export interface WebFetchProgressDetails {
	status: "progress";
	phase: "requesting" | "redirecting" | "downloading" | "converting";
	http_status?: number;
	received_bytes?: number;
	expected_bytes?: number;
	redirect_count?: number;
}

export type WebFetchDetails = WebFetchSuccessDetails | WebFetchFailureDetails | WebFetchProgressDetails;

export interface WebFetchResult {
	content: string;
	details: WebFetchSuccessDetails | WebFetchFailureDetails;
	media?: WebFetchMedia[];
}

/** 只在 runtime 与 Pi 适配层之间传递；不写入 details、缓存或遥测。 */
export interface WebFetchMedia {
	data: Uint8Array;
	mimeType: string;
	sourceUrl: string;
}

/** 搜索工具 renderer 使用的阶段进度，不进入最终模型内容。 */
export interface WebSearchProgressDetails {
	status: "progress";
	phase: "waiting" | "requesting" | "downloading" | "parsing";
	received_bytes?: number;
	expected_bytes?: number;
	wait_ms?: number;
}

/** 单个搜索 provider 的执行诊断，只供 renderer/details 使用。 */
export interface WebSearchProviderAttempt {
	provider: WebSearchProviderId;
	status: "success" | "failed" | "skipped";
	duration_ms?: number;
	error?: {
		code: WebSearchErrorCode;
		message: string;
	};
	http_status?: number;
	cached?: boolean;
	quality?: "accepted" | "partial" | "soft_miss" | "hard_failure";
	fallback_reason?: string;
	result_count?: number;
}

/** 搜索成功 details；缓存、耗时和字节数只供 UI/诊断使用。 */
export interface WebSearchSuccessDetails {
	status: "success";
	query: string;
	provider: WebSearchProviderId;
	results: WebSearchItem[];
	cached: boolean;
	downloaded_bytes: number;
	duration_ms: number;
	attempts: WebSearchProviderAttempt[];
	primary_provider?: FormalWebSearchProviderId;
	query_type?: string;
	formal_provider_calls?: number;
	secondary_new_results?: number;
	reused?: "cache" | "corpus";
	first_call_accepted?: boolean;
	fallback_reason?: string;
	provider_latencies?: string[];
	provider_errors?: string[];
	corpus_discovered?: number;
	corpus_fetched?: number;
	corpus_cited?: number;
	approximate_reformulation?: boolean;
}

/** 搜索失败 details；response_preview 只给展开 renderer 诊断。 */
export interface WebSearchFailureDetails {
	status: "failed";
	error: {
		code: WebSearchErrorCode;
		message: string;
	};
	query?: string;
	provider?: WebSearchProviderId;
	http_status?: number;
	retry_after_ms?: number;
	duration_ms?: number;
	attempts?: WebSearchProviderAttempt[];
	/**
	 * 仅供展开 renderer 诊断；不写入模型 content。
	 * 写入前必须去除标签和终端控制字符。
	 */
	response_preview?: string;
	primary_provider?: FormalWebSearchProviderId;
	query_type?: string;
	formal_provider_calls?: number;
	first_call_accepted?: boolean;
	fallback_reason?: string;
	provider_latencies?: string[];
	provider_errors?: string[];
	approximate_reformulation?: boolean;
}

export type WebSearchDetails = WebSearchProgressDetails | WebSearchSuccessDetails | WebSearchFailureDetails;

/** 搜索工具最终返回值；content 面向模型，details 面向 Pi 事件和 renderer。 */
export interface WebSearchResult {
	content: string;
	details: WebSearchSuccessDetails | WebSearchFailureDetails;
}

export interface WebFetchExecutionContext {
	toolCallId: string;
	signal?: AbortSignal;
	onUpdate?: (partial: { content: string; details: WebFetchProgressDetails }) => void;
	hasUI: boolean;
	acceptsImages?: boolean;
	imageOmissionReason?: "model_no_image_input" | "api_no_tool_image_output";
	confirm?: (title: string, message: string) => Promise<boolean>;
}

/** 搜索执行上下文；扩展层负责把 Pi progress callback 适配成该结构。 */
export interface WebSearchExecutionContext {
	toolCallId: string;
	signal?: AbortSignal;
	onUpdate?: (partial: { content: string; details: WebSearchProgressDetails }) => void;
}

export interface ValidatedUrl {
	url: URL;
	displayUrl: string;
}

export interface HttpFetchSuccess {
	status: "success";
	requestedUrl: string;
	finalUrl: string;
	httpStatus: number;
	statusText: string;
	headers: WebHttpHeaders;
	body: Uint8Array;
	authenticated: boolean;
	redirectCount: number;
	downloadedBytes: number;
}

export type HttpFetchResult = HttpFetchSuccess | { status: "failed"; details: WebFetchFailureDetails };

export interface ContentConversion {
	text: string;
	format: WebFetchOutputFormat;
	analysis: WebFetchAnalysisSummary;
	contentType?: string;
	charset?: string;
	title?: string;
	extraction?: WebFetchExtraction;
	directMedia?: WebFetchMedia;
}

/** 分页和结果契约所需的静态分析摘要；不含 DOM、正文副本或媒体字节。 */
export interface WebFetchAnalysisSummary {
	pageKind: WebFetchPageKind;
	textSource: WebFetchTextSource;
	omissions: WebFetchOmission[];
	deferredFragments: {
		discovered: number;
		resolved: number;
	};
	primaryMedia?: {
		url: string;
	};
}

export interface HtmlReadabilityOptions {
	charThreshold: number;
}

export interface WebFetchExtraction {
	analysis: PageAnalysis;
	textSource: WebFetchTextSource;
	deferredFragments: {
		discovered: number;
		resolved: number;
	};
	primaryMedia?: {
		url: string;
	};
	mediaDominant: boolean;
}

/** 兼容 undici Headers 的最小响应头接口。 */
export interface WebHttpHeaders {
	get(name: string): string | null;
	getSetCookie?: () => string[];
}

/** 两个 Web 工具共用的最小 HTTP 响应形态。 */
export interface WebHttpResponse {
	readonly status: number;
	readonly statusText: string;
	readonly headers: WebHttpHeaders;
	readonly body: WebHttpBody | null;
}

/** 可取消的 Web ReadableStream body 包装。 */
export interface WebHttpBody {
	getReader(): WebHttpBodyReader;
	cancel(): Promise<void>;
}

/** 只暴露顺序读取和取消，便于测试替换。 */
export interface WebHttpBodyReader {
	read(): Promise<{ done: boolean; value?: Uint8Array }>;
	cancel(): Promise<void>;
}

/** 固定 manual redirect 的 HTTP 请求参数；body 仅在具体调用方需要时传入。 */
export interface WebHttpRequestInit {
	method: "GET" | "POST";
	redirect: "manual";
	dispatcher?: Dispatcher;
	signal: AbortSignal;
	headers: Record<string, string>;
	body?: string;
}

/** 可注入的 HTTP fetch，用于共享安全 dispatcher 和单元测试。 */
export type WebHttpFetch = (
	input: URL,
	init: WebHttpRequestInit,
) => Promise<WebHttpResponse>;

export interface WebFetchSnapshot {
	key: string;
	createdAt: number;
	text: string;
	metadata: {
		finalUrl: string;
		httpStatus: number;
		contentType?: string;
		charset?: string;
		format: WebFetchOutputFormat;
		title?: string;
		authenticated: boolean;
		redirectCount: number;
		downloadedBytes: number;
		analysis: WebFetchAnalysisSummary;
	};
	sizeBytes: number;
}

export interface CookieAccess {
	header?: string;
	fingerprint: string;
	authenticated: boolean;
}

export interface CookieStore {
	getCookieAccess(url: URL, allowlisted: boolean): Promise<CookieAccess | WebFetchFailureDetails>;
	storeFromResponse(url: URL, setCookieHeaders: string[], allowlisted: boolean): Promise<WebFetchFailureDetails | undefined>;
}

export interface WebToolsRuntime {
	fetch(params: WebFetchParams, context: WebFetchExecutionContext): Promise<WebFetchResult>;
	search(params: WebSearchParams, context: WebSearchExecutionContext): Promise<WebSearchResult>;
	observeCitations?(text: string): void;
	close(): Promise<void>;
}

export interface WebToolsRuntimeOptions {
	dispatcher?: Dispatcher;
	fetchImpl?: WebHttpFetch;
	cookiePath?: string;
	now?: () => number;
	searchProviders?: import("./search-providers/types.js").WebSearchProvider[];
}
