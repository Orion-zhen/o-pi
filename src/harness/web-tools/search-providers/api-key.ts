import { resolveConfigValue } from "../../openai-compatible-provider/config-values.ts";

/** 缺少凭据时跳过提供方或匿名访问，不阻止路由回退。 */
export function resolveSearchApiKey(config: string): string | undefined {
	const resolved = resolveConfigValue(config);
	return resolved === undefined || resolved.trim().length === 0 ? undefined : resolved;
}
