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

export interface LookupOptions {
	lookup?: (hostname: string) => Promise<LookupAddress[]>;
	allowedFakeIpRanges?: readonly string[];
}

/** 校验模型传入的 URL；只允许无凭据的 HTTP(S)，并在请求前移除 fragment。 */
export function validateRequestUrl(rawUrl: string): ValidatedUrl | WebFetchFailureDetails {
	if (typeof rawUrl !== "string" || rawUrl.length === 0) {
		return failure("INVALID_URL", "url must be a non-empty string.");
	}
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
	const hostname = stripIpv6Brackets(url.hostname);
	if (isLocalhostName(hostname)) return failure("BLOCKED_ADDRESS", "localhost is not allowed.");
	if (ipaddr.isValid(hostname) && !isPublicAddress(hostname)) {
		return failure("BLOCKED_ADDRESS", "private or non-global address is not allowed.");
	}

	url.hash = "";
	return { url, displayUrl: redactUrl(url) };
}

/** 解析全部地址并要求每个结果都是公网地址，或显式配置的本机代理 fake-ip。 */
export async function resolveAllowedAddresses(hostname: string, options: LookupOptions = {}): Promise<ResolvedAddress[]> {
	const normalizedHostname = stripIpv6Brackets(hostname);
	// 字面 IP 不走 DNS，也不能借 DNS fake-ip 白名单放行。
	if (ipaddr.isValid(normalizedHostname)) {
		if (!isPublicAddress(normalizedHostname)) throw blockedAddressError(normalizedHostname, false);
		return [{
			address: normalizedHostname,
			family: ipaddr.parse(normalizedHostname).kind() === "ipv6" ? 6 : 4,
		}];
	}

	let addresses: LookupAddress[];
	try {
		addresses = await (options.lookup ?? defaultLookup)(normalizedHostname);
	} catch (error) {
		const err = new Error(error instanceof Error ? error.message : String(error));
		err.name = "DNS_FAILED";
		throw err;
	}
	if (addresses.length === 0) {
		const err = new Error("DNS lookup returned no addresses.");
		err.name = "DNS_FAILED";
		throw err;
	}
	const resolved = addresses
		.map((item) => ({
			address: item.address,
			family: item.family === 6 ? 6 : 4,
		}) satisfies ResolvedAddress)
		.sort((a, b) => a.family - b.family);
	const blocked = resolved.find((item) => !isAllowedResolvedAddress(item.address, options.allowedFakeIpRanges ?? []));
	if (blocked !== undefined) throw blockedAddressError(blocked.address, true);
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
	return allowedFakeIpRanges.some((range) => {
		try {
			return parsed.match(ipaddr.parseCIDR(range));
		} catch {
			return false;
		}
	});
}

export function createSecureLookup(
	getAllowedFakeIpRanges: () => readonly string[] = () => [],
	lookup?: LookupOptions["lookup"],
) {
	return (
		hostname: string,
		options: dns.LookupOneOptions | dns.LookupAllOptions | number,
		callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
	): void => {
		const all = typeof options === "object" && "all" in options && options.all === true;
		resolveAllowedAddresses(hostname, {
			allowedFakeIpRanges: getAllowedFakeIpRanges(),
			...(lookup !== undefined ? { lookup } : {}),
		})
			.then((addresses) => {
				if (all) {
					callback(null, addresses);
					return;
				}
				const first = addresses[0];
				if (first === undefined) {
					const err = new Error("DNS lookup returned no addresses.") as NodeJS.ErrnoException;
					err.code = "ENOTFOUND";
					callback(err, "", 0);
					return;
				}
				callback(null, first.address, first.family);
			})
			.catch((error) => {
				const err = new Error(error instanceof Error ? error.message : String(error)) as NodeJS.ErrnoException;
				err.code = error instanceof Error && error.name === "BLOCKED_ADDRESS" ? "EACCES" : "ENOTFOUND";
				callback(err, "", 0);
			});
	};
}

function defaultLookup(hostname: string): Promise<LookupAddress[]> {
	return dnsPromises.lookup(hostname, { all: true, verbatim: false });
}

function isLocalhostName(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	return host === "localhost" || host.endsWith(".localhost");
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
