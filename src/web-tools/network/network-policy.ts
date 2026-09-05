import dnsPromises from "node:dns/promises";
import type dns from "node:dns";
import type { LookupAddress } from "node:dns";
import ipaddr from "ipaddr.js";

import type { ValidatedUrl, WebFetchFailureDetails } from "../core/types.js";
import { redactUrl } from "./url-utils.js";

const MAX_URL_LENGTH = 8192;

export interface ResolvedAddress {
	address: string;
	family: 4 | 6;
}

export type ResolvedAddresses = [ResolvedAddress, ...ResolvedAddress[]];

export interface PinnedAddressSet {
	hostname: string;
	addresses: ResolvedAddresses;
}

export interface LookupOptions {
	allowedFakeIpRanges?: readonly string[];
	pinnedAddressSet?: PinnedAddressSet;
}

export type SecureLookupOptions = Omit<LookupOptions, "allowedFakeIpRanges">;

export interface WebFetchTargetInspection {
	status: "public" | "private";
	validated: ValidatedUrl;
	addresses: ResolvedAddresses;
}

/** 校验模型传入的 URL；只允许无凭据的 HTTP(S)，并在请求前移除 fragment。 */
export function validateRequestUrl(
	rawUrl: string,
	approvedPrivateOrigin?: string,
): ValidatedUrl | WebFetchFailureDetails {
	const parsed = parseRequestUrl(rawUrl);
	if ("status" in parsed) return parsed;
	const hostname = normalizeHostname(parsed.url.hostname);
	const approved = approvedPrivateOrigin === parsed.url.origin;
	if (isLocalhostName(hostname) && !approved) return failure("BLOCKED_ADDRESS", "localhost is not allowed.");
	if (ipaddr.isValid(hostname) && !isPublicAddress(hostname) && !approved) {
		return failure("BLOCKED_ADDRESS", "private or non-global address is not allowed.");
	}
	return parsed;
}

/** 在 tool hook 阶段解析目标，供审批策略判断并为获批连接固定地址。 */
export async function inspectWebFetchTarget(
	rawUrl: string,
	options: LookupOptions = {},
): Promise<WebFetchTargetInspection | WebFetchFailureDetails> {
	const parsed = parseRequestUrl(rawUrl);
	if ("status" in parsed) return parsed;
	const hostname = normalizeHostname(parsed.url.hostname);
	let addresses: ResolvedAddresses;
	try {
		addresses = await resolveAddresses(hostname);
	} catch (error) {
		return failure("DNS_FAILED", error instanceof Error ? error.message : String(error));
	}
	const allowedFakeIpRanges = options.allowedFakeIpRanges ?? [];
	const isPrivate = isLocalhostName(hostname)
		|| addresses.some((item) => !isAllowedResolvedAddress(item.address, allowedFakeIpRanges));
	return { status: isPrivate ? "private" : "public", validated: parsed, addresses };
}

function parseRequestUrl(rawUrl: string): ValidatedUrl | WebFetchFailureDetails {
	if (rawUrl.length > MAX_URL_LENGTH) return failure("INVALID_URL", "url is too long.");

	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return failure("INVALID_URL", "url is not valid.");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return failure("INVALID_URL", "only http and https URLs are supported.");
	}
	if (url.username !== "" || url.password !== "") {
		return failure("INVALID_URL", "URL userinfo is not allowed.");
	}
	if (url.hostname === "") return failure("INVALID_URL", "URL hostname is required.");
	url.hash = "";
	return { url, displayUrl: redactUrl(url) };
}

/** 解析全部地址并要求每个结果都是公网地址，或显式配置的本机代理 fake-ip。 */
export async function resolveAllowedAddresses(hostname: string, options: LookupOptions = {}): Promise<ResolvedAddresses> {
	const normalizedHostname = normalizeHostname(hostname);
	const pinned = options.pinnedAddressSet;
	if (pinned?.hostname === normalizedHostname) return pinned.addresses;
	const resolved = await resolveAddresses(normalizedHostname);
	// 字面 IP 不能借 DNS fake-ip 白名单放行。
	const allowedFakeIpRanges = ipaddr.isValid(normalizedHostname) ? [] : options.allowedFakeIpRanges ?? [];
	const blocked = resolved.find((item) => !isAllowedResolvedAddress(item.address, allowedFakeIpRanges));
	if (blocked !== undefined) throw blockedAddressError(blocked.address, !ipaddr.isValid(normalizedHostname));
	return resolved;
}

export function isPublicAddress(address: string): boolean {
	if (!ipaddr.isValid(address)) return false;
	const parsed = ipaddr.process(address);
	return parsed.range() === "unicast";
}

export function isAllowedResolvedAddress(address: string, allowedFakeIpRanges: readonly string[]): boolean {
	if (isPublicAddress(address)) return true;
	if (allowedFakeIpRanges.length === 0 || !ipaddr.isValid(address)) return false;
	const parsed = ipaddr.process(address);
	return allowedFakeIpRanges.some((range) => parsed.match(ipaddr.parseCIDR(range)));
}

export function createSecureLookup(
	getAllowedFakeIpRanges: () => readonly string[] = () => [],
	resolveOptions: SecureLookupOptions = {},
) {
	return (
		hostname: string,
		lookupOptions: dns.LookupOneOptions | dns.LookupAllOptions | number,
		callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
	): void => {
		const all = typeof lookupOptions === "object" && "all" in lookupOptions && lookupOptions.all === true;
		resolveAllowedAddresses(hostname, {
			...resolveOptions,
			allowedFakeIpRanges: getAllowedFakeIpRanges(),
		})
			.then((addresses) => {
				if (all) {
					callback(null, addresses);
					return;
				}
				const [first] = addresses;
				callback(null, first.address, first.family);
			})
			.catch((error) => {
				const err: NodeJS.ErrnoException = new Error(error instanceof Error ? error.message : String(error));
				err.code = error instanceof Error && error.name === "BLOCKED_ADDRESS" ? "EACCES" : "ENOTFOUND";
				callback(err, "", 0);
			});
	};
}

async function resolveAddresses(hostname: string): Promise<ResolvedAddresses> {
	if (ipaddr.isValid(hostname)) {
		return [{
			address: hostname,
			family: ipaddr.parse(hostname).kind() === "ipv6" ? 6 : 4,
		}];
	}
	const [first, ...rest] = await dnsPromises.lookup(hostname, { all: true, verbatim: false });
	if (first === undefined) throw new Error("DNS lookup returned no addresses.");
	const resolved: ResolvedAddresses = [toResolvedAddress(first), ...rest.map(toResolvedAddress)];
	resolved.sort((a, b) => a.family - b.family);
	return resolved;
}

function toResolvedAddress(address: LookupAddress): ResolvedAddress {
	if (address.family !== 4 && address.family !== 6) {
		throw new Error(`DNS lookup returned unsupported address family ${address.family}.`);
	}
	return { address: address.address, family: address.family };
}

function isLocalhostName(hostname: string): boolean {
	return hostname === "localhost" || hostname.endsWith(".localhost");
}

function normalizeHostname(hostname: string): string {
	return stripIpv6Brackets(hostname).toLowerCase().replace(/\.$/u, "");
}

function stripIpv6Brackets(hostname: string): string {
	return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function blockedAddressError(address: string, dnsResult: boolean): Error {
	const error = new Error(dnsResult
		? `DNS resolved to blocked address ${address}.`
		: `Target address ${address} is blocked.`);
	error.name = "BLOCKED_ADDRESS";
	return error;
}

function failure(code: WebFetchFailureDetails["error"]["code"], message: string): WebFetchFailureDetails {
	return { status: "failed", error: { code, message } };
}
