import { execSync } from "node:child_process";

const commandResultCache = new Map<string, string | undefined>();
// 非法的 ${...} 整段保留，不能继续解析其中的 $。
const CONFIG_VALUE_TOKEN = /\$(?:([$!])|\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*)|\{[^}]*\})/g;

export function resolveConfigValueOrThrow(config: string, description: string, env?: Record<string, string>): string {
	const resolvedValue = resolveConfigValue(config, env);
	if (resolvedValue !== undefined) return resolvedValue;

	if (isCommandConfigValue(config)) {
		throw new Error(`Failed to resolve ${description} from shell command: ${config.slice(1)}`);
	}

	const missingEnvVars = getMissingConfigValueEnvVarNames(config, env);
	if (missingEnvVars.length === 1) {
		throw new Error(`Failed to resolve ${description} from environment variable: ${missingEnvVars[0]}`);
	}
	if (missingEnvVars.length > 1) {
		throw new Error(`Failed to resolve ${description} from environment variables: ${missingEnvVars.join(", ")}`);
	}
	throw new Error(`Failed to resolve ${description}`);
}

export function resolveHeadersOrThrow(
	headers: Record<string, string> | undefined,
	description: string,
	env?: Record<string, string>,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		resolved[key] = resolveConfigValueOrThrow(value, `${description} header "${key}"`, env);
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

function getMissingConfigValueEnvVarNames(config: string, env?: Record<string, string>): string[] {
	return getConfigValueEnvVarNames(config).filter((name) => resolveEnvConfigValue(name, env) === undefined);
}

export function getConfigValueEnvVarNames(config: string): string[] {
	if (isCommandConfigValue(config)) return [];
	const names: string[] = [];
	for (let match = CONFIG_VALUE_TOKEN.exec(config); match !== null; match = CONFIG_VALUE_TOKEN.exec(config)) {
		const name = match[2] ?? match[3];
		if (name !== undefined && !names.includes(name)) names.push(name);
	}
	return names;
}

export function isCommandConfigValue(config: string): boolean {
	return config.startsWith("!");
}

export function resolveConfigValue(config: string, env?: Record<string, string>): string | undefined {
	if (isCommandConfigValue(config)) return executeCachedCommand(config);
	let resolved = "";
	let end = 0;
	for (let match = CONFIG_VALUE_TOKEN.exec(config); match !== null; match = CONFIG_VALUE_TOKEN.exec(config)) {
		const name = match[2] ?? match[3];
		const value = name === undefined ? match[1] ?? match[0] : resolveEnvConfigValue(name, env);
		if (value === undefined) {
			CONFIG_VALUE_TOKEN.lastIndex = 0;
			return undefined;
		}
		resolved += config.slice(end, match.index) + value;
		end = CONFIG_VALUE_TOKEN.lastIndex;
	}
	return resolved + config.slice(end);
}

function resolveEnvConfigValue(name: string, env?: Record<string, string>): string | undefined {
	return env?.[name] || process.env[name] || undefined;
}

function executeCachedCommand(commandConfig: string): string | undefined {
	if (commandResultCache.has(commandConfig)) return commandResultCache.get(commandConfig);
	const result = executeCommand(commandConfig.slice(1));
	commandResultCache.set(commandConfig, result);
	return result;
}

function executeCommand(command: string): string | undefined {
	try {
		const output = execSync(command, {
			encoding: "utf-8",
			timeout: 10_000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return output.trim() || undefined;
	} catch {
		return undefined;
	}
}
