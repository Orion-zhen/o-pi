import type { WebHttpResponse } from "../../src/web-tools/types.js";

class FakeBody {
	constructor(private readonly chunks: Uint8Array[]) {}

	getReader() {
		let index = 0;
		return {
			read: async () => {
				const value = this.chunks[index++];
				return value === undefined ? { done: true as const } : { done: false as const, value };
			},
			cancel: async () => undefined,
		};
	}

	async cancel(): Promise<void> {}
}

export function httpResponse(
	status: number,
	body: string | Uint8Array,
	headers: Record<string, string> = { "content-type": "text/plain" },
): WebHttpResponse {
	return {
		status,
		statusText: status >= 200 && status < 300 ? "OK" : "Error",
		headers: new Headers(headers),
		body: new FakeBody([typeof body === "string" ? Buffer.from(body) : body]),
	};
}
