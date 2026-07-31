export type UsageProviderId = "anthropic" | "openai-codex" | "kimi-coding" | "xai";

export interface UsageWindow {
	label: string;
	sectionLabel?: string;
	usedPercent: number | undefined;
	windowDurationMins: number | undefined;
	resetsAt: string | undefined;
}

export interface CollectedUsageWindow extends Omit<UsageWindow, "resetsAt"> {
	resetsAt: Date | undefined;
}

export interface UsageDetail {
	label: string;
	value: string;
}

export interface UsageResetCredit {
	status: string;
	grantedAt: string | undefined;
	expiresAt: string | undefined;
}

export interface CollectedUsageResetCredit extends Omit<UsageResetCredit, "grantedAt" | "expiresAt"> {
	grantedAt: Date | undefined;
	expiresAt: Date | undefined;
}

export interface UsageResetCredits {
	availableCount: number;
	credits: UsageResetCredit[] | undefined;
}

export interface CollectedUsageResetCredits extends Omit<UsageResetCredits, "credits"> {
	credits: CollectedUsageResetCredit[] | undefined;
}

type ProviderUsageBase<TWindow, TResetCredits> = {
	id: UsageProviderId;
	name: string;
} & (
	| {
			status: "ok";
			plan: string | undefined;
			windows: TWindow[];
			details: UsageDetail[];
			resetCredits: TResetCredits | undefined;
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

export type ProviderUsage = ProviderUsageBase<UsageWindow, UsageResetCredits>;
export type CollectedProviderUsage = ProviderUsageBase<CollectedUsageWindow, CollectedUsageResetCredits>;

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
	generatedAt: string;
	timeZone: string;
	providers: ProviderUsage[];
}

export interface CollectedUsageSnapshot {
	generatedAt: Date;
	timeZone: string;
	providers: CollectedProviderUsage[];
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
