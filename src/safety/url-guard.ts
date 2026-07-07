import ipaddr from "ipaddr.js";

export interface UrlGuardOptions {
	allow_http?: boolean;
	allow_private_literal_ip?: boolean;
}

export function guardPublicHttpUrlLiteral(value: string, options: UrlGuardOptions = {}): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("URL must be valid.");
	}
	if (url.protocol !== "https:" && !(url.protocol === "http:" && options.allow_http !== false)) {
		throw new Error("URL only supports http: and https:.");
	}
	if (url.username !== "" || url.password !== "") {
		throw new Error("URL must not include username or password.");
	}

	const host = normalizedHostname(url);
	if (host === "localhost" || host.endsWith(".localhost")) {
		throw new Error("URL must not use localhost.");
	}
	if (ipaddr.isValid(host) && options.allow_private_literal_ip !== true) {
		const address = ipaddr.parse(host);
		const range = address.range();
		if (range !== "unicast") {
			throw new Error("URL must not use private, loopback, or link-local literal IP addresses.");
		}
	}
	return url;
}

function normalizedHostname(url: URL): string {
	const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
	if (hostname.startsWith("[") && hostname.endsWith("]")) return hostname.slice(1, -1);
	return hostname;
}
