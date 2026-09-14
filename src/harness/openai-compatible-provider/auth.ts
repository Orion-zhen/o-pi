import type {
	ApiKeyAuth,
	ApiKeyCredential,
	AuthContext,
	AuthResult,
	ProviderHeaders,
} from "@earendil-works/pi-ai";

import {
	getConfigValueEnvVarNames,
	isCommandConfigValue,
	resolveConfigValueOrThrow,
	resolveHeadersOrThrow,
} from "./config-values.ts";
import type { ProviderConfig } from "./schema.ts";

const EMPTY_API_KEY = "EMPTY";
const UNUSED_API_KEY = "unused";
const KEYLESS_AUTH_ENV = "\u0000o-pi-openai-compatible-keyless";
const PROVIDER_HEADERS_ENV = "\u0000o-pi-openai-compatible-provider-headers";

/** 为原生 pi-ai Provider 构造用户配置驱动的认证。 */
export function createProviderAuth(providerId: string, provider: ProviderConfig): ApiKeyAuth {
	const safeProvider = providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
	const apiKeyConfig = provider.apiKey || `$PI_MODELS_JSONC_${safeProvider}_API_KEY`;
	const explicitlyKeyless = provider.apiKey === EMPTY_API_KEY;
	const headerConfigs = provider.headers;
	return {
		name: `${provider.name ?? providerId} API key`,
		async login(interaction): Promise<ApiKeyCredential> {
			interaction.signal.throwIfAborted();
			const key = await interaction.prompt({ type: "secret", message: "API key" });
			interaction.signal.throwIfAborted();
			return { type: "api_key", key };
		},
		async check({ ctx, credential, signal }) {
			signal.throwIfAborted();
			if (!await areConfigValuesAvailable(Object.values(headerConfigs ?? {}), ctx, credential?.env, signal)) return undefined;
			if (credential?.key) return { type: "api_key", source: "stored API key" };
			if (explicitlyKeyless) return { type: "api_key", source: "keyless provider" };
			if (await isConfigValueAvailable(apiKeyConfig, ctx, credential?.env, signal)) {
				return { type: "api_key", source: configValueSource(apiKeyConfig) };
			}
			const authHeader = findAuthHeaderConfig(headerConfigs);
			return authHeader && await isConfigValueAvailable(authHeader, ctx, credential?.env, signal)
				? { type: "api_key", source: "configured auth header" }
				: undefined;
		},
		async resolve({ ctx, credential, signal }): Promise<AuthResult | undefined> {
			signal.throwIfAborted();
			const values = [
				...(credential?.key ? [] : [apiKeyConfig]),
				...Object.values(headerConfigs ?? {}),
			];
			const env = await resolveEnvironment(values, ctx, credential?.env, signal);
			const configuredHeaders = resolveHeadersOrThrow(headerConfigs, `provider "${providerId}"`, env);
			const credentialKey = credential?.key;
			const keyConfigAvailable = getConfigValueEnvVarNames(apiKeyConfig).every((name) => env[name] !== undefined);
			const resolvedKey = credentialKey ?? (keyConfigAvailable
				? resolveConfigValueOrThrow(apiKeyConfig, `API key for provider "${providerId}"`, env)
				: undefined);
			const keyless = resolvedKey === EMPTY_API_KEY || (credentialKey === undefined && explicitlyKeyless);
			const hasConfiguredAuthHeader = hasAuthHeader(configuredHeaders);
			signal.throwIfAborted();

			if (!keyless && resolvedKey === undefined && !hasConfiguredAuthHeader) return undefined;

			const resolvedEnv = {
				...env,
				...(keyless ? { [KEYLESS_AUTH_ENV]: "1" } : {}),
				...(configuredHeaders ? { [PROVIDER_HEADERS_ENV]: JSON.stringify(configuredHeaders) } : {}),
			};
			return {
				auth: {
					apiKey: keyless || resolvedKey === undefined ? UNUSED_API_KEY : resolvedKey,
				},
				...(Object.keys(resolvedEnv).length > 0 ? { env: resolvedEnv } : {}),
				source: credentialKey
					? "stored API key"
					: keyless
						? "keyless provider"
						: resolvedKey !== undefined
							? configValueSource(apiKeyConfig)
							: "configured auth header",
			};
		},
	};
}

/** refreshModels 已收到 Pi 解析后的 credential；据此构造模型目录请求认证。 */
export function resolveRefreshAuth(
	providerId: string,
	credential: ApiKeyCredential,
): { apiKey?: string; headers?: Record<string, string>; keyless: boolean } {
	const keyless = credential.env?.[KEYLESS_AUTH_ENV] === "1";
	const headers = resolvedProviderHeaders(providerId, credential.env);
	return {
		...(!keyless && credential.key !== undefined ? { apiKey: credential.key } : {}),
		...(headers ? { headers } : {}),
		keyless,
	};
}

/** 请求头只在传输边界合并，避免 Pi 预先合并后丢失调用方覆盖信息。 */
export function resolveProviderRequestHeaders(providerId: string, env: Record<string, string> | undefined): ProviderHeaders {
	const headers: ProviderHeaders = { ...resolvedProviderHeaders(providerId, env) };
	if ((env?.[KEYLESS_AUTH_ENV] === "1" || hasAuthHeader(headers)) && !hasAuthorizationHeader(headers)) {
		headers.Authorization = null;
	}
	return headers;
}

function resolvedProviderHeaders(
	providerId: string,
	env: Record<string, string> | undefined,
): Record<string, string> | undefined {
	const serialized = env?.[PROVIDER_HEADERS_ENV];
	if (!serialized) return undefined;
	const parsed: unknown = JSON.parse(serialized);
	if (!isStringRecord(parsed)) {
		throw new TypeError(`Resolved provider headers for provider "${providerId}" are invalid`);
	}
	return parsed;
}

async function resolveEnvironment(
	values: string[],
	ctx: AuthContext,
	seed: Record<string, string> | undefined,
	signal: AbortSignal,
): Promise<Record<string, string>> {
	const env = { ...seed };
	const names = new Set(values.flatMap(getConfigValueEnvVarNames));
	for (const name of names) {
		signal.throwIfAborted();
		if (env[name] !== undefined) continue;
		const value = await ctx.env(name);
		signal.throwIfAborted();
		if (value !== undefined) env[name] = value;
	}
	return env;
}

async function areConfigValuesAvailable(
	values: string[],
	ctx: AuthContext,
	seed: Record<string, string> | undefined,
	signal: AbortSignal,
): Promise<boolean> {
	const availability = await Promise.all(values.map((value) => isConfigValueAvailable(value, ctx, seed, signal)));
	signal.throwIfAborted();
	return availability.every(Boolean);
}

async function isConfigValueAvailable(
	value: string,
	ctx: AuthContext,
	seed: Record<string, string> | undefined,
	signal: AbortSignal,
): Promise<boolean> {
	signal.throwIfAborted();
	if (isCommandConfigValue(value)) return true;
	const env = await resolveEnvironment([value], ctx, seed, signal);
	return getConfigValueEnvVarNames(value).every((name) => env[name] !== undefined);
}

function configValueSource(value: string): string {
	if (isCommandConfigValue(value)) return "configured command";
	const names = getConfigValueEnvVarNames(value);
	return names.length > 0 ? names.join(", ") : "configured API key";
}

function findAuthHeaderConfig(headers: Record<string, string> | undefined): string | undefined {
	return Object.entries(headers ?? {}).find(([name]) => isAuthHeaderName(name))?.[1];
}

function hasAuthHeader(headers: ProviderHeaders | undefined): boolean {
	return Object.keys(headers ?? {}).some(isAuthHeaderName);
}

function hasAuthorizationHeader(headers: ProviderHeaders): boolean {
	return Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return typeof value === "object"
		&& value !== null
		&& !Array.isArray(value)
		&& Object.values(value).every((item) => typeof item === "string");
}

function isAuthHeaderName(name: string): boolean {
	const normalized = name.toLowerCase();
	return normalized === "authorization" || normalized === "cf-aig-authorization";
}
