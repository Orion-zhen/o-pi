import type { NetworkScope, ResolvedAddresses } from "./network-policy.ts";

export interface PrivateNetworkGrant {
	scope: Exclude<NetworkScope, "public">;
	origin: string;
	hostname: string;
	addresses: ResolvedAddresses;
}

const grants = new WeakMap<object, PrivateNetworkGrant>();

export function attachPrivateNetworkGrant(
	input: object,
	scope: PrivateNetworkGrant["scope"],
	origin: string,
	addresses: ResolvedAddresses,
): void {
	grants.set(input, { scope, origin, hostname: normalizeHostname(new URL(origin).hostname), addresses });
}

export function readPrivateNetworkGrant(input: object): PrivateNetworkGrant | undefined {
	return grants.get(input);
}

function normalizeHostname(hostname: string): string {
	const unwrapped = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
	return unwrapped.toLowerCase().replace(/\.$/u, "");
}
