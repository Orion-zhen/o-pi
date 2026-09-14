import type { ResolvedAddresses } from "./network-policy.js";

export interface PrivateNetworkGrant {
	origin: string;
	hostname: string;
	addresses: ResolvedAddresses;
}

const grants = new WeakMap<object, PrivateNetworkGrant>();

export function createPrivateNetworkGrantFor(
	origin: string,
	addresses: ResolvedAddresses,
): PrivateNetworkGrant {
	return {
		origin,
		hostname: normalizeHostname(new URL(origin).hostname),
		addresses,
	};
}

export function attachPrivateNetworkGrant(input: object, grant: PrivateNetworkGrant): void {
	grants.set(input, grant);
}

export function readPrivateNetworkGrant(input: object): PrivateNetworkGrant | undefined {
	return grants.get(input);
}

function normalizeHostname(hostname: string): string {
	const unwrapped = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
	return unwrapped.toLowerCase().replace(/\.$/u, "");
}
