const SENSITIVE_QUERY_NAMES = new Set([
	"token",
	"access_token",
	"refresh_token",
	"key",
	"api_key",
	"secret",
	"signature",
	"sig",
	"auth",
	"authorization",
	"session",
	"sessionid",
	"password",
	"passwd",
	"code",
	"credential",
	"jwt",
]);

export function redactUrl(value: string | URL): string {
	const url = typeof value === "string" ? new URL(value) : new URL(value.toString());
	url.hash = "";
	for (const [key] of url.searchParams) {
		if (SENSITIVE_QUERY_NAMES.has(key.toLowerCase())) url.searchParams.set(key, "REDACTED");
	}
	return url.toString();
}

export function compactUrl(value: unknown, maxLength = 80): string {
	if (typeof value !== "string" || value.length === 0) return "...";
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return truncateMiddle(value, maxLength);
	}
	const query = url.search ? "?..." : "";
	const text = `${url.host}${url.pathname === "/" ? "" : url.pathname}${query}`;
	return truncateMiddle(text, maxLength);
}

export function shortUrlForCall(args: unknown): string {
	if (!isRecord(args) || typeof args["url"] !== "string") return "...";
	return compactUrl(args["url"], 80);
}

export function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 移除网页文本可能夹带的 ANSI/OSC 终端控制序列。 */
export function stripTerminalControls(value: string): string {
	return value
		.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function normalizeUrl(input: URL): string {
	const url = new URL(input.toString());
	url.hash = "";
	return url.toString();
}

export function originKey(url: URL): string {
	return `${url.protocol}//${url.host}`;
}

export function matchesDomainRule(hostname: string, rules: readonly string[]): boolean {
	const host = hostname.toLowerCase();
	return rules.some((rule) => {
		const normalized = rule.toLowerCase();
		if (normalized.startsWith("*.")) {
			const suffix = normalized.slice(2);
			return host.endsWith(`.${suffix}`) && host.length > suffix.length + 1;
		}
		return host === normalized;
	});
}

export function truncateMiddle(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	if (maxLength <= 3) return value.slice(0, maxLength);
	const head = Math.ceil((maxLength - 3) / 2);
	const tail = Math.floor((maxLength - 3) / 2);
	return `${value.slice(0, head)}...${value.slice(value.length - tail)}`;
}

export function formatChars(value: number): string {
	return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value);
}

export function formatBytes(value: number): string {
	if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
	if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
	return `${value} B`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
