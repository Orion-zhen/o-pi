import { matchesDomainRule } from "./url-utils.js";

/** Lightweight allowlist check; importing it must not initialize tough-cookie. */
export function isCookieAllowed(hostname: string, domains: readonly string[]): boolean {
	return domains.length > 0 && matchesDomainRule(hostname, domains);
}
