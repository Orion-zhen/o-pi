export interface CodexQuotaWindow {
	usedPercent: number | undefined;
	windowDurationMins: number | undefined;
	resetsAt: Date | undefined;
}

export interface CodexQuotaBucket {
	id: string;
	name: string | undefined;
	planType: string | undefined;
	primary: CodexQuotaWindow | undefined;
	secondary: CodexQuotaWindow | undefined;
	credits: {
		hasCredits: boolean;
		unlimited: boolean;
		balance: string | undefined;
	} | undefined;
}

export interface CodexResetCredit {
	id: string;
	resetType: string;
	status: string;
	grantedAt: Date | undefined;
	expiresAt: Date | undefined;
	title: string | undefined;
	description: string | undefined;
}

export interface CodexResetCredits {
	availableCount: number;
	credits: CodexResetCredit[] | undefined;
}

export interface CodexQuotaSnapshot {
	generatedAt: Date;
	timeZone: string;
	buckets: CodexQuotaBucket[];
	resetCredits: CodexResetCredits | undefined;
}

export type CodexQuotaErrorCode =
	| "command_not_found"
	| "startup_failed"
	| "timeout"
	| "aborted"
	| "process_failed"
	| "protocol_error"
	| "server_error"
	| "unexpected_response";

/** app-server 错误只保留稳定的错误码，避免把进程输出或响应正文带入浮层。 */
export class CodexQuotaError extends Error {
	constructor(readonly code: CodexQuotaErrorCode, message: string) {
		super(message);
		this.name = "CodexQuotaError";
	}
}
