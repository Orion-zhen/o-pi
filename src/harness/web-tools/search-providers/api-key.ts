import { execSync } from "node:child_process";

const commandResultCache = new Map<string, string | undefined>();
// 非法的 ${...} 整段保留，不能继续解析其中的 $。
const CONFIG_VALUE_TOKEN = /\$(?:([$!])|\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*)|\{[^}]*\})/g;

/** 缺少凭据时跳过提供方或匿名访问，不阻止路由回退。 */
export function resolveSearchApiKey(config: string): string | undefined {
	const resolved = config.startsWith("!") ? executeCachedCommand(config) : resolveEnvironment(config);
	return resolved === undefined || resolved.trim().length === 0 ? undefined : resolved;
}

function resolveEnvironment(config: string): string | undefined {
	let resolved = "";
	let end = 0;
	for (const match of config.matchAll(CONFIG_VALUE_TOKEN)) {
		const name = match[2] ?? match[3];
		const value = name === undefined ? match[1] ?? match[0] : process.env[name] || undefined;
		if (value === undefined) return undefined;
		resolved += config.slice(end, match.index) + value;
		end = match.index + match[0].length;
	}
	return resolved + config.slice(end);
}

function executeCachedCommand(config: string): string | undefined {
	if (commandResultCache.has(config)) return commandResultCache.get(config);
	let result: string | undefined;
	try {
		result = execSync(config.slice(1), { encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
	} catch {
		result = undefined;
	}
	commandResultCache.set(config, result);
	return result;
}
