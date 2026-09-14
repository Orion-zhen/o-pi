import type { Dispatcher } from "undici";
import type { WebFetchFailureDetails } from "../core/types.js";

export interface ValidatedUrl {
	url: URL;
	displayUrl: string;
	fragment: string;
}

export interface HttpFetchSuccess {
	status: "success";
	requestedUrl: string;
	finalUrl: string;
	/** 留给内容选区，HTTP 请求不发送 fragment。 */
	fragment: string;
	httpStatus: number;
	headers: WebHttpHeaders;
	body: Uint8Array;
	/** 明确不会返回直接图片时，只读响应头并取消正文。 */
	bodyOmitted?: "skipped_image_body";
	authenticated: boolean;
	redirectCount: number;
	downloadedBytes: number;
}

export type HttpFetchResult = HttpFetchSuccess | { status: "failed"; details: WebFetchFailureDetails };

export interface WebHttpHeaders {
	get(name: string): string | null;
	getSetCookie(): string[];
}

export interface WebHttpResponse {
	readonly status: number;
	readonly statusText: string;
	readonly headers: WebHttpHeaders;
	readonly body: WebHttpBody | null;
}

export interface WebHttpBody {
	getReader(): WebHttpBodyReader;
	cancel(): Promise<void>;
}

export interface WebHttpBodyReader {
	read(): Promise<{ done: boolean; value?: Uint8Array }>;
	cancel(): Promise<void>;
}

/** 重定向由安全网络边界显式处理。 */
export interface WebHttpRequestInit {
	method: "GET" | "POST";
	redirect: "manual";
	dispatcher?: Dispatcher;
	signal: AbortSignal;
	headers: Record<string, string>;
	body?: string;
}

export type WebHttpFetch = (input: URL, init: WebHttpRequestInit) => Promise<WebHttpResponse>;
