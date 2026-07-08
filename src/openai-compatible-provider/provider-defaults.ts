export function defaultApiKeyConfig(providerId: string): string {
	const safeProvider = providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
	return `$PI_MODELS_JSONC_${safeProvider}_API_KEY`;
}
