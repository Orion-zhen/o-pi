import { resolveConfigValueOrThrow } from "../../openai-compatible-provider/config-values.js";

/** Resolve the shared config-value syntax without making an unavailable key fatal to fallback routing. */
export function resolveSearchApiKey(config: string): string | undefined {
	try {
		const resolved = resolveConfigValueOrThrow(config, "search provider API key");
		return resolved.trim().length > 0 ? resolved : undefined;
	} catch {
		return undefined;
	}
}
