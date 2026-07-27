export type UsageProviderId = "anthropic" | "openai-codex" | "kimi-coding" | "xai";

export interface UsageWindow {
	label: string;
	sectionLabel?: string;
	usedPercent: number | undefined;
	windowDurationMins: number | undefined;
	resetsAt: Date | undefined;
}

export interface UsageDetail {
	label: string;
	value: string;
}

export interface UsageResetCredit {
	status: string;
	grantedAt: Date | undefined;
	expiresAt: Date | undefined;
}

export interface UsageResetCredits {
	availableCount: number;
	credits: UsageResetCredit[] | undefined;
}

export type ProviderUsage = {
	id: UsageProviderId;
	name: string;
} & (
	| {
			status: "ok";
			plan: string | undefined;
			windows: UsageWindow[];
			details: UsageDetail[];
			resetCredits: UsageResetCredits | undefined;
	  }
	| {
			status: "not_logged_in";
			loginProvider: UsageProviderId;
	  }
	| {
			status: "error";
			error: UsageProviderError;
	  }
);

export type UsageProviderErrorCode =
	| "auth"
	| "timeout"
	| "http"
	| "response_too_large"
	| "invalid_response"
	| "request_failed";

export interface UsageProviderError {
	code: UsageProviderErrorCode;
	httpStatus: number | undefined;
}

export interface UsageSnapshot {
	generatedAt: Date;
	timeZone: string;
	providers: ProviderUsage[];
}

export type UsageRequestErrorCode = "aborted" | "timeout" | "http" | "response_too_large" | "invalid_response" | "request_failed";

/** 网络边界只保留稳定错误码和 HTTP 状态，不携带响应正文或 OAuth token。 */
export class UsageRequestError extends Error {
	constructor(
		readonly code: UsageRequestErrorCode,
		readonly httpStatus?: number,
	) {
		super(code);
		this.name = "UsageRequestError";
	}
}
