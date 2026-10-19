export type UsageProviderId = "anthropic" | "openai-codex" | "kimi-coding" | "xai" | "deepseek";

export interface UsageWindow {
	label: string;
	sectionLabel?: string;
	usedPercent: number | undefined;
	windowDurationMins: number | undefined;
	resetsAt: string | undefined;
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

export interface UsageResetCredits {
	availableCount: number;
	credits: UsageResetCredit[] | undefined;
}

interface ProviderIdentity {
	id: UsageProviderId;
	name: string;
}

export interface UsageBalance {
	currency: "CNY" | "USD";
	total: string;
	granted: string;
	toppedUp: string;
}

export type ProviderUsageData =
	| {
		kind: "plan";
		plan: string | undefined;
		windows: UsageWindow[];
		details: UsageDetail[];
		resetCredits: UsageResetCredits | undefined;
	}
	| {
		kind: "balance";
		isAvailable: boolean;
		balances: UsageBalance[];
	};

export type ProviderUsage =
	| (ProviderIdentity & { status: "ok" } & ProviderUsageData)
	| (ProviderIdentity & {
		status: "error";
		error: UsageProviderError;
	});

export type UsageProviderError =
	| { code: "http"; httpStatus: number }
	| { code: "auth" | "timeout" | "response_too_large" | "invalid_response" | "request_failed" };

export interface UsageSnapshot {
	generatedAt: string;
	timeZone: string;
	providers: ProviderUsage[];
}

export type UsageRequestErrorCode = "aborted" | "timeout" | "response_too_large" | "invalid_response" | "request_failed";

/** 网络边界只保留稳定错误码，不携带响应正文或凭据。 */
export class UsageRequestError extends Error {
	constructor(readonly code: UsageRequestErrorCode) {
		super(code);
		this.name = "UsageRequestError";
	}
}
