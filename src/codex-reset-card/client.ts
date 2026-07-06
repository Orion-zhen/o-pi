import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CodexResetCardError, type CodexResetCard, type CodexResetCardSnapshot } from "./types.js";

const RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const DEFAULT_TIMEOUT_MS = 30_000;

const CARD_LIST_KEYS = ["credits", "reset_credits", "rate_limit_reset_credits", "cards", "items", "data"] as const;
const ISSUE_FIELD_NAMES = [
	"issued_at",
	"issue_at",
	"granted_at",
	"created_at",
	"start_time",
	"starts_at",
	"activated_at",
	"available_at",
	"grant_time",
	"grant_date",
	"create_time",
] as const;
const EXPIRE_FIELD_NAMES = [
	"expires_at",
	"expire_at",
	"expiration_time",
	"expired_at",
	"valid_until",
	"end_time",
	"ends_at",
	"expiry",
	"expires",
	"expiration_date",
	"expire_time",
] as const;
const USED_FIELD_NAMES = ["used_at", "redeemed_at", "consumed_at", "applied_at", "used_time", "redeem_time"] as const;

export interface CodexResetCardClientOptions {
	authPath?: string;
	fetchImpl?: typeof fetch;
	now?: Date;
	signal?: AbortSignal;
	timeoutMs?: number;
}

/** 读取 Codex 登录态并查询 ChatGPT 后端返回的重置卡列表。 */
export async function collectCodexResetCardSnapshot(options: CodexResetCardClientOptions = {}): Promise<CodexResetCardSnapshot> {
	const token = await readCodexAccessToken(options.authPath ?? getDefaultAuthPath());
	const response = await requestResetCredits(token, options);
	const cards = extractCards(response);

	return {
		cards,
		generatedAt: options.now ?? new Date(),
		timeZone: getSystemTimeZone(),
	};
}

/** 从 ~/.codex/auth.json 兼容读取 Codex access token。 */
export async function readCodexAccessToken(authPath: string): Promise<string> {
	let raw: string;
	try {
		raw = await readFile(authPath, "utf8");
	} catch (error) {
		const code = hasNodeCode(error, "ENOENT") ? "auth_file_not_found" : "auth_file_unreadable";
		throw new CodexResetCardError(code, code === "auth_file_not_found" ? "Codex auth file not found." : "Codex auth file is unreadable.", {
			path: authPath,
		});
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		throw new CodexResetCardError("auth_file_unreadable", "Codex auth file is not valid JSON.", { path: authPath });
	}

	const token = parseCodexAccessToken(parsed);
	if (!token) throw new CodexResetCardError("access_token_not_found", "Codex access token not found.", { path: authPath });
	return token;
}

/** 兼容 Codex auth.json 中常见的 tokens.access_token 与 access_token 两种结构。 */
export function parseCodexAccessToken(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;

	const tokens = value.tokens;
	if (isRecord(tokens) && typeof tokens.access_token === "string" && tokens.access_token.length > 0) {
		return tokens.access_token;
	}
	return typeof value.access_token === "string" && value.access_token.length > 0 ? value.access_token : undefined;
}

/** 从接口 JSON 中提取重置卡；仅使用字段名白名单和一层嵌套回退，避免误读任意正文。 */
export function extractCards(value: unknown): CodexResetCard[] {
	const rawCards = findCardList(value);
	if (!rawCards) {
		throw new CodexResetCardError("unexpected_json_shape", "Reset card response shape is not recognized.", {
			topLevelKeys: isRecord(value) ? Object.keys(value) : [],
		});
	}

	return rawCards.filter(isRecord).map((card) => ({
		issuedAt: findDate(card, ISSUE_FIELD_NAMES),
		expiresAt: findDate(card, EXPIRE_FIELD_NAMES),
		usedAt: findDate(card, USED_FIELD_NAMES),
	}));
}

/** 解析接口可能返回的秒、毫秒、数字字符串或 ISO 时间，统一转成 Date。 */
export function parseApiDate(value: unknown): Date | undefined {
	if (value === null || value === undefined) return undefined;
	if (typeof value === "number") return parseNumericDate(value);
	if (typeof value !== "string") return undefined;

	const text = value.trim();
	if (text.length === 0) return undefined;
	const numeric = Number(text);
	if (Number.isFinite(numeric)) return parseNumericDate(numeric);

	const normalized = text.endsWith("Z") ? `${text.slice(0, -1)}+00:00` : text;
	const timestamp = Date.parse(normalized);
	return Number.isFinite(timestamp) ? new Date(timestamp) : undefined;
}

function getDefaultAuthPath(): string {
	return join(homedir(), ".codex", "auth.json");
}

function getSystemTimeZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

async function requestResetCredits(token: string, options: CodexResetCardClientOptions): Promise<unknown> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeout = createTimeoutSignal(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	try {
		const response = await fetchImpl(RESET_CREDITS_URL, {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/json",
				"User-Agent": "Mozilla/5.0",
			},
			signal: timeout.signal,
		});

		if (response.status === 401) {
			throw new CodexResetCardError("unauthorized", "Codex access token is unauthorized.");
		}
		if (!response.ok) {
			throw new CodexResetCardError("http_error", "Reset card request failed.", { status: response.status });
		}

		try {
			return (await response.json()) as unknown;
		} catch {
			throw new CodexResetCardError("non_json_response", "Reset card response is not valid JSON.");
		}
	} catch (error) {
		if (error instanceof CodexResetCardError) throw error;
		throw new CodexResetCardError("request_failed", "Reset card request failed.");
	} finally {
		timeout.dispose();
	}
}

function createTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const onAbort = () => controller.abort(parent?.reason);

	if (parent?.aborted) onAbort();
	else parent?.addEventListener("abort", onAbort, { once: true });

	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timer);
			parent?.removeEventListener("abort", onAbort);
		},
	};
}

function findCardList(value: unknown): unknown[] | undefined {
	if (Array.isArray(value)) return value;
	if (!isRecord(value)) return undefined;

	for (const key of CARD_LIST_KEYS) {
		const candidate = value[key];
		if (Array.isArray(candidate)) return candidate;
		if (isRecord(candidate)) {
			for (const nestedKey of CARD_LIST_KEYS) {
				const nested = candidate[nestedKey];
				if (Array.isArray(nested)) return nested;
			}
		}
	}
	return undefined;
}

function findDate(card: Record<string, unknown>, names: readonly string[]): Date | undefined {
	for (const name of names) {
		if (name in card) return parseApiDate(card[name]);
	}

	for (const value of Object.values(card)) {
		if (!isRecord(value)) continue;
		for (const name of names) {
			if (name in value) return parseApiDate(value[name]);
		}
	}
	return undefined;
}

function parseNumericDate(value: number): Date | undefined {
	if (!Number.isFinite(value)) return undefined;
	const seconds = value > 10_000_000_000 ? value / 1000 : value;
	return new Date(seconds * 1000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasNodeCode(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}
