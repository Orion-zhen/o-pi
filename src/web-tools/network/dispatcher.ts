import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { Dispatcher } from "undici";

import type { WebToolsConfig } from "../core/types.js";
import { createSecureLookup, resolveAllowedAddresses, type LookupOptions } from "./network-policy.js";

type UndiciNetworkModule = Pick<typeof import("undici"), "Agent" | "ProxyAgent" | "interceptors">;
type NetworkConfig = WebToolsConfig["network"];

const TARGET_DNS_TTL_MS = 10_000;

export interface NetworkDispatcherOptions {
	/** 仅供网络边界测试注入；生产环境使用系统 DNS。 */
	lookup?: LookupOptions["lookup"];
}

/** 按完整网络配置创建一个可安全直连或代理的共享 dispatcher。 */
export function createNetworkDispatcher(
	network: NetworkConfig,
	undici: UndiciNetworkModule,
	options: NetworkDispatcherOptions = {},
): Dispatcher {
	const allowedFakeIpRanges = [...network.fake_ip_ranges];
	if (!network.proxy.enabled) {
		return new undici.Agent({
			connect: {
				lookup: createSecureLookup(() => allowedFakeIpRanges, options.lookup),
			},
		});
	}

	const secureTargetDns = createSecureTargetDnsInterceptor(undici, allowedFakeIpRanges, options.lookup);
	return new undici.Agent({
		factory(origin) {
			const target = new URL(origin);
			const proxyUrl = selectProxyUrl(target.protocol, network.proxy);
			const servername = targetServername(target.hostname);
			const proxy = servername === undefined
				? new undici.ProxyAgent({ uri: proxyUrl })
				: new undici.ProxyAgent({ uri: proxyUrl, requestTls: { servername } });
			return proxy.compose(secureTargetDns);
		},
	});
}

/** 网络配置热更新时按签名复用 dispatcher，旧签名保留到 runtime 关闭。 */
export function networkConfigSignature(network: NetworkConfig): string {
	const proxy = network.proxy;
	const material = JSON.stringify([
		[...network.fake_ip_ranges].sort(),
		proxy.enabled,
		...(proxy.enabled ? [proxy.http_proxy, proxy.https_proxy, proxy.socks5_proxy] : []),
	]);
	return createHash("sha256").update(material).digest("hex");
}

function selectProxyUrl(protocol: string, proxy: NetworkConfig["proxy"]): string {
	const candidates = protocol === "http:"
		? [proxy.http_proxy, proxy.socks5_proxy, proxy.https_proxy]
		: [proxy.https_proxy, proxy.socks5_proxy, proxy.http_proxy];
	const selected = candidates.find((value) => value !== "");
	if (selected === undefined) throw new Error("enabled web proxy has no endpoint");
	return selected;
}

function targetServername(hostname: string): string | undefined {
	const unwrapped = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
	return isIP(unwrapped) === 0 ? unwrapped : undefined;
}

function createSecureTargetDnsInterceptor(
	undici: UndiciNetworkModule,
	allowedFakeIpRanges: readonly string[],
	lookup: LookupOptions["lookup"] | undefined,
): Dispatcher.DispatcherComposeInterceptor {
	return undici.interceptors.dns({
		maxTTL: TARGET_DNS_TTL_MS,
		lookup(origin, _options, callback) {
			void resolveAllowedAddresses(origin.hostname, {
				allowedFakeIpRanges,
				...(lookup !== undefined ? { lookup } : {}),
			}).then(
				(addresses) => callback(null, addresses.map((address) => ({ ...address, ttl: TARGET_DNS_TTL_MS }))),
				(error: unknown) => callback(proxyLookupError(error), []),
			);
		},
	});
}

function proxyLookupError(error: unknown): NodeJS.ErrnoException {
	const result: NodeJS.ErrnoException = new Error(error instanceof Error ? error.message : String(error));
	result.code = error instanceof Error && error.name === "BLOCKED_ADDRESS" ? "EACCES" : "ENOTFOUND";
	return result;
}
