export type WebFetchMode = "readable" | "source";
export type WebFetchOutputFormat = "markdown" | "text" | "json" | "xml" | "image" | "source";
export type WebFetchPageKind = "article" | "image" | "video" | "audio" | "generic";
export type WebFetchTextSource = "readability" | "semantic" | "body" | "metadata";
export type SnapshotStatus = "created" | "hit" | "refetched" | "not_needed";
export type FormalWebSearchProviderId = "brave_api" | "exa_api" | "tavily";
export type WebSearchProviderId = FormalWebSearchProviderId | "duckduckgo_html";

export interface WebFetchParams {
	url: string;
	mode?: WebFetchMode;
	find?: string;
	offset?: number;
	limit?: number;
}

export interface WebSearchParams {
	query: string;
	limit?: number;
}

export interface WebSearchItem {
	rank: number;
	title: string;
	url: string;
	snippet?: string;
	/** 合并来源只供 details 和遥测使用，不进入模型正文。 */
	provenance?: Array<{ provider: FormalWebSearchProviderId; rank: number }>;
}

export type WebFetchErrorCode =
	| "CONFIG_ERROR" | "INVALID_ARGUMENT" | "INVALID_URL" | "BLOCKED_ADDRESS" | "COOKIE_ERROR"
	| "AUTH_CONFIRMATION_REQUIRED" | "DNS_FAILED" | "CONNECTION_FAILED" | "TLS_FAILED"
	| "TIMEOUT" | "ABORTED" | "TOO_MANY_REDIRECTS" | "HTTP_ERROR"
	| "RESPONSE_TOO_LARGE" | "UNSUPPORTED_CONTENT_TYPE" | "CONVERSION_FAILED" | "ANCHOR_NOT_FOUND";

export type WebSearchErrorCode =
	| "INVALID_ARGUMENT" | "CONFIG_ERROR" | "DNS_FAILED" | "CONNECTION_FAILED" | "TLS_FAILED"
	| "TIMEOUT" | "ABORTED" | "HTTP_ERROR" | "RESPONSE_TOO_LARGE" | "UNSUPPORTED_CONTENT_TYPE"
	| "QUOTA_EXHAUSTED" | "RATE_LIMITED" | "NO_PROVIDER_AVAILABLE" | "PROVIDER_BLOCKED" | "PARSE_FAILED";

export interface WebFetchFailureDetails {
	status: "failed";
	error: { code: WebFetchErrorCode; message: string };
	requested_url?: string;
	final_url?: string;
	http_status?: number;
	authenticated?: boolean;
	redirect_count?: number;
	duration_ms?: number;
	response_preview?: string;
}

export interface WebFetchTextSpan {
	start: number;
	end: number;
}

export type WebFetchRange = {
	/** 读取或查找的起点，坐标相对当前模式和锚点选区。 */
	start: number;
	total: number;
	has_more: boolean;
	next_offset?: number;
} & (
	| { kind: "read"; end: number }
	| { kind: "find"; matches: number; passages: WebFetchTextSpan[] }
);

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
	/** 原生锚点选区，字符范围相对此选区。 */
	anchor?: string;
	content_type?: string;
	charset?: string;
	format: WebFetchOutputFormat;
	downloaded_bytes: number;
	total_chars: number;
	range: WebFetchRange;
	authenticated: boolean;
	redirect_count: number;
	snapshot: SnapshotStatus;
	deferred_fragments: { discovered: number; resolved: number; limited: boolean };
	media: { discovered: number; returned: number };
	duration_ms: number;
	/** 展开呈现器使用的短预览，不含包装标签。 */
	preview: string;
}

export interface WebFetchOmission {
	kind: "deferred_content" | "primary_media" | "embedded_content" | "structured_data" | "interactive_content";
	reason:
		| "unresolved_declaration" | "model_no_image_input" | "api_no_tool_image_output"
		| "media_fetch_failed" | "media_too_large" | "unsupported_media_type"
		| "video_not_returned" | "audio_not_returned" | "iframe_not_fetched" | "invalid_or_limited" | "client_rendered";
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

/** 仅在运行时与 Pi 适配层间传递，不写入 details、缓存或遥测。 */
export interface WebFetchMedia {
	data: Uint8Array;
	mimeType: string;
}

export interface WebSearchProgressDetails {
	status: "progress";
	phase: "waiting" | "requesting" | "downloading" | "parsing";
	received_bytes?: number;
	expected_bytes?: number;
	wait_ms?: number;
}

export interface WebSearchProviderAttempt {
	provider: WebSearchProviderId;
	status: "success" | "failed";
	duration_ms?: number;
	error?: { code: WebSearchErrorCode; message: string };
	http_status?: number;
	quality?: "accepted" | "partial" | "soft_miss" | "hard_failure";
	result_count?: number;
}

export interface WebSearchSuccessDetails {
	status: "success";
	query: string;
	provider: WebSearchProviderId;
	results: WebSearchItem[];
	downloaded_bytes: number;
	duration_ms: number;
	attempts: WebSearchProviderAttempt[];
	query_type?: string;
}

export interface WebSearchFailureDetails {
	status: "failed";
	error: { code: WebSearchErrorCode; message: string };
	query?: string;
	provider?: WebSearchProviderId;
	http_status?: number;
	retry_after_ms?: number;
	duration_ms?: number;
	attempts?: WebSearchProviderAttempt[];
	/** 展开诊断使用，必须先去除标签和终端控制字符，不写入模型正文。 */
	response_preview?: string;
	query_type?: string;
}

export type WebSearchDetails = WebSearchProgressDetails | WebSearchSuccessDetails | WebSearchFailureDetails;

export interface WebSearchResult {
	content: string;
	details: WebSearchSuccessDetails | WebSearchFailureDetails;
}

export interface WebFetchExecutionContext {
	toolCallId: string;
	/** approval-gate 在工具钩子中签发，仅供网络边界使用。 */
	privateNetworkGrant?: import("../network/private-network-grant.js").PrivateNetworkGrant;
	signal?: AbortSignal;
	onUpdate?: (partial: { content: string; details: WebFetchProgressDetails }) => void;
	acceptsImages?: boolean;
	imageOmissionReason?: "model_no_image_input" | "api_no_tool_image_output";
	interaction?: WebFetchInteractionPort;
}

export interface WebFetchInteractionPort {
	confirmAuthentication(title: string, message: string): Promise<boolean>;
}

export interface WebSearchExecutionContext {
	toolCallId: string;
	signal?: AbortSignal;
	onUpdate?: (partial: { content: string; details: WebSearchProgressDetails }) => void;
}

export interface CookieAccess {
	header?: string;
}

export interface CookieStore {
	getCookieAccess(url: URL): Promise<CookieAccess | WebFetchFailureDetails>;
	storeFromResponse(url: URL, setCookieHeaders: string[]): Promise<WebFetchFailureDetails | undefined>;
}

export interface WebToolsRuntime {
	fetch(params: WebFetchParams, context: WebFetchExecutionContext): Promise<WebFetchResult>;
	search(params: WebSearchParams, context: WebSearchExecutionContext): Promise<WebSearchResult>;
	close(): Promise<void>;
}
