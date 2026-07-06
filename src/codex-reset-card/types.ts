/** 单张 Codex 重置卡的关键时间信息，字段缺失时保持 undefined 以便 UI 明确显示未知。 */
export interface CodexResetCard {
	issuedAt: Date | undefined;
	expiresAt: Date | undefined;
	usedAt: Date | undefined;
}

/** /codex-reset-card 的一次查询快照；timeZone 来自当前系统 Intl 配置。 */
export interface CodexResetCardSnapshot {
	cards: CodexResetCard[];
	generatedAt: Date;
	timeZone: string;
}

export type CodexResetCardErrorCode =
	| "auth_file_not_found"
	| "auth_file_unreadable"
	| "access_token_not_found"
	| "unauthorized"
	| "http_error"
	| "request_failed"
	| "non_json_response"
	| "unexpected_json_shape";

/** 查询失败时只携带脱敏后的错误码和必要元数据，避免把响应正文或 token 暴露到 UI。 */
export class CodexResetCardError extends Error {
	constructor(
		readonly code: CodexResetCardErrorCode,
		message: string,
		readonly details: Record<string, string | number | string[]> = {},
	) {
		super(message);
		this.name = "CodexResetCardError";
	}
}
