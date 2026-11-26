import { loadWebToolsConfig } from "../config.ts";
import { resolveWebProxy } from "../network/dispatcher.ts";
import { inspectWebFetchTarget } from "../network/network-policy.ts";
import { attachPrivateNetworkGrant } from "../network/private-network-grant.ts";

export async function preflightWebFetch(input: { url: string }) {
	const config = await loadWebToolsConfig();
	const inspection = await inspectWebFetchTarget(input.url, config.network.fake_ip_ranges);
	if ("error" in inspection) return { error: `${inspection.error.code}: ${inspection.error.message}` };
	const { status, validated, addresses } = inspection;
	const scope = status === "loopback" && (await resolveWebProxy(validated.url, config.network.proxy)).enabled ? "private" : status;
	const origin = validated.url.origin;
	return {
		target: { scope, origin, url: validated.displayUrl, addresses: addresses.map(({ address }) => address) },
		...(scope !== "public" ? { grantPrivateAccess: () => attachPrivateNetworkGrant(input, scope, origin, addresses) } : {}),
	};
}
