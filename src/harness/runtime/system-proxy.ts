/** Electron 返回 PAC 格式的有序路由。只按首选路由连接，不在失败时擅自直连。 */
export function systemProxyUrl(result: string): string | undefined {
	const route = result.split(";", 1)[0]?.trim();
	if (route === "DIRECT") return undefined;
	const match = /^(PROXY|HTTPS|SOCKS5|SOCKS)\s+(\S+)$/.exec(route ?? "");
	if (!match) throw new Error(`Unsupported system proxy route: ${route}`);
	const protocol = match[1] === "PROXY" ? "http" : match[1] === "HTTPS" ? "https" : "socks5";
	return new URL(`${protocol}://${match[2]}`).href;
}
