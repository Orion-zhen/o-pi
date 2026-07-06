/** 将 api_key 配置值脱敏成可诊断但不泄露密钥的字符串。 */
export function redact_api_key(value: string | undefined | null): string {
	if (!value) return "<missing>";
	if (value === "EMPTY") return "<empty-placeholder>";
	if (value.startsWith("!")) return "<command:redacted>";
	if (value.startsWith("$")) return `<env:${extractEnvName(value)}>`;
	return "<literal:redacted>";
}

function extractEnvName(value: string): string {
	const braced = /^\$\{([^}]+)\}$/.exec(value);
	if (braced?.[1]) return braced[1];
	return value.slice(1);
}
