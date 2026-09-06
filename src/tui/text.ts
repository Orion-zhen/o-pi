const ANSI_PATTERN = /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|\([0-~]|\)[0-~]|[PX^_].*?\u001b\\)/gs;

/** 清理 ANSI、OSC 和终端控制字符，避免外部文本污染 TUI。 */
export function cleanText(value: unknown): string {
	return String(value ?? "")
		.replace(ANSI_PATTERN, "")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ");
}

/** 压缩空白为单空格，适合工具卡片摘要。 */
export function compactWhitespace(value: string): string {
	return cleanText(value).replace(/\s+/g, " ").trim();
}

/** 尾部截断；maxChars 小于等于 1 时只返回省略号。 */
export function truncateEnd(value: string, maxChars: number): string {
	const chars = [...value];
	if (chars.length <= maxChars) return value;
	if (maxChars <= 1) return "…";
	return `${chars.slice(0, maxChars - 1).join("")}…`;
}

/** 中间截断，保留目标路径、URL 或命令的首尾关键信息。 */
export function truncateMiddle(value: string, maxChars: number): string {
	const chars = [...value];
	if (chars.length <= maxChars) return value;
	if (maxChars <= 1) return "…";
	const keep = maxChars - 1;
	const head = Math.ceil(keep / 2);
	const tail = Math.floor(keep / 2);
	return `${chars.slice(0, head).join("")}…${chars.slice(chars.length - tail).join("")}`;
}

/** 毫秒转短耗时，供工具卡片和 footer 使用。 */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	return `${minutes}m${seconds > 0 ? `${seconds}s` : ""}`;
}

/** 字节数转短文本。 */
export function formatBytes(value: number): string {
	if (!Number.isFinite(value) || value < 0) return "";
	if (value < 1024) return `${Math.round(value)} B`;
	const units = ["KB", "MB", "GB"];
	let amount = value / 1024;
	let unit = units[0] ?? "KB";
	for (let index = 1; index < units.length && amount >= 1024; index += 1) {
		amount /= 1024;
		unit = units[index] ?? unit;
	}
	return `${amount.toFixed(amount < 10 ? 1 : 0)} ${unit}`;
}

/** 字符数转短文本；用于网页和写文件摘要。 */
export function formatChars(value: number): string {
	return `${formatCount(value)} chars`;
}

/** 数量转短文本，千以上使用 k。 */
function formatCount(value: number): string {
	if (!Number.isFinite(value)) return "";
	if (Math.abs(value) < 1000) return String(Math.round(value));
	return `${(value / 1000).toFixed(Math.abs(value) < 10_000 ? 1 : 0)}k`;
}

/** 过滤空项后用分隔符连接。 */
export function joinParts(parts: Array<string | undefined | false | null>, separator = " · "): string {
	return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(separator);
}
