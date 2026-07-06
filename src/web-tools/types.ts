import type { Dispatcher } from "undici";

export type WebFetchMode = "readable" | "source";
export type WebFetchOutputFormat = "markdown" | "text" | "json" | "xml" | "source";
export type SnapshotStatus = "created" | "hit" | "refetched" | "not_needed";
/** 搜索运行时 provider 标识；不暴露为模型工具参数。 */
export type WebSearchProviderId = "exa_mcp" | "duckduckgo_html";

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
}

export interface WebToolsConfig {
	version: 2;
	network: {
		/** 两个 Web 工具共用的安全 DNS fake-ip 放行范围。 */
		fake_ip_ranges: string[];
	};
	websearch: {
		/** 搜索 provider 执行顺序；重复项会在加载配置时去重。 */
		provider_order: WebSearchProviderId[];
		/** provider 失败后是否继续尝试后续 provider。 */
		fallback: boolean;
		default_results: number;
		/** 会话内搜索缓存 TTL，按成功 provider 签名隔离。 */
		cache_ttl_seconds: number;
		exa_mcp: {
			enabled: boolean;
			url: string;
			tool: string;
			api_key_env: string;
			timeout_seconds: number;
			type: string;
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
	| "MCP_ERROR"
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
	duration_ms: number;
	/** 供展开 renderer 使用的短预览，不含包装标签。 */
	preview: string;
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
	duration_ms?: number;
	attempts?: WebSearchProviderAttempt[];
	/**
	 * 仅供展开 renderer 诊断；不写入模型 content。
	 * 写入前必须去除标签和终端控制字符。
	 */
	response_preview?: string;
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
	contentType?: string;
	charset?: string;
	title?: string;
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
	close(): Promise<void>;
}

export interface WebToolsRuntimeOptions {
	dispatcher?: Dispatcher;
	fetchImpl?: WebHttpFetch;
	cookiePath?: string;
	now?: () => number;
	exaMcpClientFactory?: import("./search-providers/exa-mcp.js").ExaMcpClientFactory;
	searchProviders?: import("./search-providers/types.js").WebSearchProvider[];
}
