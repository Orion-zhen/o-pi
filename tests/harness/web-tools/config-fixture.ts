import { readFileSync } from "node:fs";
import { parse } from "jsonc-parser";

import type { WebToolsConfig } from "../../../src/harness/web-tools/config-types.js";
import { normalizeDomains } from "../../../src/harness/web-tools/search-providers/query.js";

export function defaultWebToolsConfig(): WebToolsConfig {
	const { network, websearch, webfetch } = parse(readFileSync(new URL("../../../agent/defaults/web-tools.jsonc", import.meta.url), "utf8")) as WebToolsConfig;
	websearch.include_domains = normalizeDomains(websearch.include_domains);
	websearch.exclude_domains = normalizeDomains(websearch.exclude_domains);
	return { network, websearch, webfetch };
}
