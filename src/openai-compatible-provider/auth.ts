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
} from "./config-values.js";
import { defaultApiKeyConfig } from "./provider-defaults.js";
import type { ProviderConfig } from "./schema.js";

const EMPTY_API_KEY = "EMPTY";
const UNUSED_API_KEY = "unused";
const KEYLESS_AUTH_ENV = "\u0000o-pi-openai-compatible-keyless";
const PROVIDER_HEADERS_ENV = "\u0000o-pi-openai-compatible-provider-headers";

/** 为原生 pi-ai Provider 构造用户配置驱动的认证。 */
export function createProviderAuth(providerId: string, provider: ProviderConfig): ApiKeyAuth {
	const apiKeyConfig = configuredApiKey(providerId, provider);
	const headerConfigs = provider.headers;
	return {
		name: `${provider.name ?? providerId} API key`,
		async login(interaction): Promise<ApiKeyCredential> {
			return {
				type: "api_key",
				key: await interaction.prompt({ type: "secret", message: "API key" }),
			};
		},
		async check({ ctx, credential }) {
			if (!await areConfigValuesAvailable(Object.values(headerConfigs ?? {}), ctx, credential?.env)) return undefined;
			if (credential?.key) return { type: "api_key", source: "stored API key" };
			if (isExplicitKeyless(provider)) return { type: "api_key", source: "keyless provider" };
			if (await isConfigValueAvailable(apiKeyConfig, ctx, credential?.env)) {
				return { type: "api_key", source: configValueSource(apiKeyConfig) };
			}
			const authHeader = findAuthHeaderConfig(headerConfigs);
			return authHeader && await isConfigValueAvailable(authHeader, ctx, credential?.env)
				? { type: "api_key", source: "configured auth header" }
				: undefined;
		},
		async resolve({ ctx, credential }): Promise<AuthResult | undefined> {
			const values = [
				...(credential?.key ? [] : [apiKeyConfig]),
				...Object.values(headerConfigs ?? {}),
			];
			const env = await resolveEnvironment(values, ctx, credential?.env);
			const configuredHeaders = resolveHeadersOrThrow(headerConfigs, `provider "${providerId}"`, env);
			const credentialKey = credential?.key;
			const keyConfigAvailable = getConfigValueEnvVarNames(apiKeyConfig).every((name) => env[name] !== undefined);
			const resolvedKey = credentialKey ?? (keyConfigAvailable
				? resolveConfigValueOrThrow(apiKeyConfig, `API key for provider "${providerId}"`, env)
				: undefined);
			const keyless = resolvedKey === EMPTY_API_KEY || (credentialKey === undefined && isExplicitKeyless(provider));
			const hasConfiguredAuthHeader = hasAuthHeader(configuredHeaders);

			if (!keyless && resolvedKey === undefined && !hasConfiguredAuthHeader) return undefined;

			const headers: ProviderHeaders = { ...configuredHeaders };
			if ((keyless || hasConfiguredAuthHeader) && !hasAuthorizationHeader(headers)) {
				headers.Authorization = null;
			}
			const resolvedEnv = {
				...env,
				...(keyless ? { [KEYLESS_AUTH_ENV]: "1" } : {}),
				...(configuredHeaders ? { [PROVIDER_HEADERS_ENV]: JSON.stringify(configuredHeaders) } : {}),
			};
			return {
				auth: {
					apiKey: keyless || resolvedKey === undefined ? UNUSED_API_KEY : resolvedKey,
					...(Object.keys(headers).length > 0 ? { headers } : {}),
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
	provider: ProviderConfig,
	credential: ApiKeyCredential | undefined,
): { apiKey?: string; headers?: Record<string, string>; keyless: boolean } {
	const env = credential?.env;
	const headers = resolveHeadersOrThrow(provider.headers, `provider "${providerId}"`, env);
	const keyless = credential?.env?.[KEYLESS_AUTH_ENV] === "1"
		|| credential?.key === EMPTY_API_KEY
		|| (credential?.key === undefined && isExplicitKeyless(provider));
	return {
		...(keyless ? {} : credential?.key ? { apiKey: credential.key } : {}),
		...(headers ? { headers } : {}),
		keyless,
	};
}

export function resolvedProviderHeaders(env: Record<string, string> | undefined): Record<string, string> | undefined {
	const serialized = env?.[PROVIDER_HEADERS_ENV];
	if (!serialized) return undefined;
	try {
		const parsed: unknown = JSON.parse(serialized);
		if (!isStringRecord(parsed)) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

function configuredApiKey(providerId: string, provider: ProviderConfig): string {
	return provider.apiKey && provider.apiKey.length > 0 ? provider.apiKey : defaultApiKeyConfig(providerId);
}

function isExplicitKeyless(provider: ProviderConfig): boolean {
	return provider.apiKey === EMPTY_API_KEY;
}

async function resolveEnvironment(
	values: string[],
	ctx: AuthContext,
	seed: Record<string, string> | undefined,
): Promise<Record<string, string>> {
	const env = { ...seed };
	const names = new Set(values.flatMap(getConfigValueEnvVarNames));
	for (const name of names) {
		if (env[name] !== undefined) continue;
		const value = await ctx.env(name);
		if (value !== undefined) env[name] = value;
	}
	return env;
}

async function areConfigValuesAvailable(
	values: string[],
	ctx: AuthContext,
	seed: Record<string, string> | undefined,
): Promise<boolean> {
	const availability = await Promise.all(values.map((value) => isConfigValueAvailable(value, ctx, seed)));
	return availability.every(Boolean);
}

async function isConfigValueAvailable(
	value: string,
	ctx: AuthContext,
	seed: Record<string, string> | undefined,
): Promise<boolean> {
	if (isCommandConfigValue(value)) return true;
	const env = await resolveEnvironment([value], ctx, seed);
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

function hasAuthHeader(headers: Record<string, string> | undefined): boolean {
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
