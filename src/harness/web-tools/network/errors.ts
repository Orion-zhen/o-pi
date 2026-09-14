export function classifyNetworkError(error: unknown, userSignal?: AbortSignal): "DNS_FAILED" | "CONNECTION_FAILED" | "TLS_FAILED" | "TIMEOUT" | "ABORTED" | "BLOCKED_ADDRESS" {
	const codeText = `${errorCause(error)?.code ?? ""} ${networkErrorMessage(error)}`.toLowerCase();
	if (userSignal?.aborted) return "ABORTED";
	if (codeText.includes("timeout") || error instanceof DOMException && error.name === "TimeoutError") return "TIMEOUT";
	if (codeText.includes("certificate") || codeText.includes("tls")) return "TLS_FAILED";
	if (codeText.includes("dns") || codeText.includes("enotfound")) return "DNS_FAILED";
	if (codeText.includes("blocked") || codeText.includes("eacces")) return "BLOCKED_ADDRESS";
	return "CONNECTION_FAILED";
}

export function networkErrorMessage(error: unknown): string {
	return [error instanceof Error ? error.message : String(error), errorCause(error)?.message].filter(Boolean).join(": ");
}

function errorCause(error: unknown): { message?: string; code?: string } | undefined {
	if (typeof error !== "object" || error === null || !("cause" in error)) return undefined;
	const cause = error.cause;
	if (typeof cause !== "object" || cause === null) return undefined;
	return {
		...("message" in cause && typeof cause.message === "string" ? { message: cause.message } : {}),
		...("code" in cause && typeof cause.code === "string" ? { code: cause.code } : {}),
	};
}
