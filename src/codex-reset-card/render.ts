import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { CodexResetCardError, type CodexResetCard, type CodexResetCardSnapshot } from "./types.js";

const WIDE_MIN_WIDTH = 80;
const TIME_WIDTH = 19;
const INDEX_WIDTH = 3;
const STATE_WIDTH = 8;
const WIDE_TABLE_GAP = "   ";
const WIDE_TABLE_GAPS_WIDTH = visibleWidth(WIDE_TABLE_GAP) * 4;

type CardState = "available" | "pending" | "used" | "expired" | "unknown";

interface RenderedCard {
	index: string;
	state: string;
	issuedAt: string;
	expiresAt: string;
	usage: string;
}

/** 渲染 /codex-reset-card 查询结果；宽屏用表格，窄屏用分块列表。 */
export function renderCodexResetCards(snapshot: CodexResetCardSnapshot, width: number): string[] {
	const safeWidth = Math.max(1, width);
	const rendered = snapshot.cards.map((card, index) => renderCard(card, index + 1, snapshot));
	const summary = summarizeCards(snapshot.cards, snapshot.generatedAt);
	const lines = [
		`Codex Reset Cards · ${snapshot.cards.length} 张 · 可用 ${summary.available} · 已用 ${summary.used} · 过期 ${summary.expired}`,
		`系统时区 ${snapshot.timeZone} · 查询 ${formatDateTime(snapshot.generatedAt, snapshot.timeZone)}`,
		"",
		...(rendered.length === 0
			? ["当前没有重置卡。"]
			: safeWidth >= WIDE_MIN_WIDTH
				? renderWideTable(rendered, safeWidth)
				: renderCompactList(rendered, safeWidth)),
		"",
		"Esc / Enter / q 关闭",
	];
	return lines.map((line) => fit(line, safeWidth));
}

/** 渲染脱敏错误信息；不包含 token、响应正文或唯一请求内容。 */
export function renderCodexResetCardError(error: unknown, width: number): string[] {
	const safeWidth = Math.max(1, width);
	const details = error instanceof CodexResetCardError ? formatErrorDetails(error) : [];
	const lines = ["Codex Reset Cards · 查询失败", "", getErrorMessage(error), ...details, "", "Esc / Enter / q 关闭"];
	return lines.map((line) => fit(line, safeWidth));
}

function renderCard(card: CodexResetCard, index: number, snapshot: CodexResetCardSnapshot): RenderedCard {
	const state = getCardState(card, snapshot.generatedAt);
	return {
		index: String(index),
		state: formatState(state),
		issuedAt: formatDateTime(card.issuedAt, snapshot.timeZone),
		expiresAt: formatDateTime(card.expiresAt, snapshot.timeZone),
		usage: formatUsage(card, state, snapshot),
	};
}

function renderWideTable(cards: RenderedCard[], width: number): string[] {
	const fixedWidth = INDEX_WIDTH + STATE_WIDTH + TIME_WIDTH + TIME_WIDTH + WIDE_TABLE_GAPS_WIDTH;
	const usageWidth = Math.max(visibleWidth("使用情况"), width - fixedWidth);
	const lines = [
		[padEnd("序号", INDEX_WIDTH), padEnd("状态", STATE_WIDTH), padEnd("发放时间", TIME_WIDTH), padEnd("到期时间", TIME_WIDTH), "使用情况"].join(
			WIDE_TABLE_GAP,
		),
		["─".repeat(INDEX_WIDTH), "─".repeat(STATE_WIDTH), "─".repeat(TIME_WIDTH), "─".repeat(TIME_WIDTH), "─".repeat(usageWidth)].join(
			WIDE_TABLE_GAP,
		),
	];
	for (const card of cards) {
		lines.push([padEnd(card.index, INDEX_WIDTH), padEnd(card.state, STATE_WIDTH), padEnd(card.issuedAt, TIME_WIDTH), padEnd(card.expiresAt, TIME_WIDTH), fit(card.usage, usageWidth)].join(WIDE_TABLE_GAP));
	}
	return lines;
}

function renderCompactList(cards: RenderedCard[], width: number): string[] {
	const lines: string[] = [];
	for (const card of cards) {
		if (lines.length > 0) lines.push("");
		lines.push(`#${card.index} ${card.state} · ${card.usage}`);
		lines.push(`发放 ${card.issuedAt}`);
		lines.push(`到期 ${card.expiresAt}`);
	}
	return lines.map((line) => fit(line, width));
}

function summarizeCards(cards: CodexResetCard[], now: Date): { available: number; used: number; expired: number } {
	let available = 0;
	let used = 0;
	let expired = 0;

	for (const card of cards) {
		const state = getCardState(card, now);
		if (state === "available") available += 1;
		else if (state === "used") used += 1;
		else if (state === "expired") expired += 1;
	}
	return { available, used, expired };
}

function getCardState(card: CodexResetCard, now: Date): CardState {
	if (card.usedAt) return "used";
	if (card.expiresAt && card.expiresAt <= now) return "expired";
	if (card.issuedAt && card.issuedAt > now) return "pending";
	if (card.expiresAt) return "available";
	return "unknown";
}

function formatState(state: CardState): string {
	if (state === "available") return "可用";
	if (state === "pending") return "未生效";
	if (state === "used") return "已用";
	if (state === "expired") return "过期";
	return "未知";
}

function formatUsage(card: CodexResetCard, state: CardState, snapshot: CodexResetCardSnapshot): string {
	if (state === "used") return `已用 ${formatDateTime(card.usedAt, snapshot.timeZone)}`;
	if (state === "expired" && card.expiresAt) return `已过期 ${formatDuration(snapshot.generatedAt.getTime() - card.expiresAt.getTime())}`;
	if (state === "pending" && card.issuedAt) return `${formatDuration(card.issuedAt.getTime() - snapshot.generatedAt.getTime())} 后可用`;
	if (state === "available" && card.expiresAt) return `剩余 ${formatDuration(card.expiresAt.getTime() - snapshot.generatedAt.getTime())}`;
	return "缺少有效期";
}

function formatDateTime(date: Date | undefined, timeZone: string): string {
	if (!date) return "未知";
	const formatter = new Intl.DateTimeFormat("zh-CN", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
	return formatter.format(date).replace(/\//g, "-");
}

function formatDuration(milliseconds: number): string {
	const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
	if (minutes < 1) return "不足1分钟";

	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const mins = minutes % 60;
	if (days > 0) return hours > 0 ? `${days}天 ${hours}小时` : `${days}天`;
	if (hours > 0) return mins > 0 ? `${hours}小时 ${mins}分钟` : `${hours}小时`;
	return `${mins}分钟`;
}

function getErrorMessage(error: unknown): string {
	if (!(error instanceof CodexResetCardError)) return "请求失败，请稍后重试。";
	if (error.code === "auth_file_not_found") return "未找到 ~/.codex/auth.json，请先登录 Codex。";
	if (error.code === "auth_file_unreadable") return "无法读取 ~/.codex/auth.json。";
	if (error.code === "access_token_not_found") return "未在 Codex 登录文件中找到 access token。";
	if (error.code === "unauthorized") return "Codex access token 已失效，请重新登录。";
	if (error.code === "http_error") return `接口返回 HTTP ${String(error.details.status ?? "错误")}。`;
	if (error.code === "non_json_response") return "接口返回内容不是 JSON。";
	if (error.code === "unexpected_json_shape") return "接口 JSON 结构不符合预期。";
	return "请求失败，请检查网络后重试。";
}

function formatErrorDetails(error: CodexResetCardError): string[] {
	if (error.code !== "unexpected_json_shape") return [];
	const keys = error.details.topLevelKeys;
	return Array.isArray(keys) && keys.length > 0 ? [`顶层字段：${keys.join(", ")}`] : [];
}

function fit(text: string, width: number): string {
	return truncateToWidth(text, width, "");
}

function padEnd(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}
