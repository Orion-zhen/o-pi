import type { WebFetchMedia, WebFetchOmission, WebFetchOutputFormat, WebFetchPageKind, WebFetchTextSource } from "../core/types.js";
import type { HttpFetchSuccess } from "../network/types.js";

export interface ContentConversion {
	text: string;
	format: WebFetchOutputFormat;
	analysis: WebFetchAnalysisSummary;
	contentType?: string;
	charset?: string;
	title?: string;
	directMedia?: WebFetchMedia;
}

/** 分页所需的静态分析摘要，不保留 DOM 和正文副本。 */
export interface WebFetchAnalysisSummary {
	pageKind: WebFetchPageKind;
	textSource: WebFetchTextSource;
	omissions: WebFetchOmission[];
	deferredFragments: { discovered: number; resolved: number; limited: boolean };
	primaryMedia?: { url: string };
}

export interface HtmlReadabilityOptions {
	charThreshold: number;
}

/** 下载转换和分页缓存共用的页面，不保留 HTTP 正文或响应头对象。 */
export interface WebFetchPage extends ContentConversion {
	response: Pick<HttpFetchSuccess, "requestedUrl" | "finalUrl" | "httpStatus" | "authenticated" | "redirectCount" | "downloadedBytes">;
}
