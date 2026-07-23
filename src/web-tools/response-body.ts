import type { WebHttpHeaders, WebHttpResponse } from "./types.js";

/** 共享受限正文读取结果；失败码保持通用，由调用工具映射到自身错误结构。 */
export type ResponseBodyReadResult =
	| {
			status: "success";
			bytes: Uint8Array;
	  }
	| {
			status: "failed";
			code: "RESPONSE_TOO_LARGE" | "ABORTED" | "CONNECTION_FAILED";
			message: string;
	  };

/** 读取有上限的响应正文；调用方负责把通用错误映射到具体工具的 details。 */
export async function readLimitedResponseBody(
	response: WebHttpResponse,
	options: {
		maxBytes: number;
		onProgress?: (receivedBytes: number) => void;
		signal?: AbortSignal;
	},
): Promise<ResponseBodyReadResult> {
	const expected = contentLength(response.headers);
	if (options.signal?.aborted) return abortedResult(options.signal.reason);
	if (expected !== undefined && expected > options.maxBytes) {
		cancelQuietly(response.body);
		return {
			status: "failed",
			code: "RESPONSE_TOO_LARGE",
			message: `response exceeded ${options.maxBytes} bytes.`,
		};
	}
	if (response.body === null) return { status: "success", bytes: new Uint8Array() };

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await readWithSignal(reader, options.signal);
			if (done) break;
			if (value === undefined) continue;
			total += value.byteLength;
			if (total > options.maxBytes) {
				cancelQuietly(reader);
				return {
					status: "failed",
					code: "RESPONSE_TOO_LARGE",
					message: `response exceeded ${options.maxBytes} bytes.`,
				};
			}
			chunks.push(value);
			options.onProgress?.(total);
		}
	} catch (error) {
		if (options.signal?.aborted) return abortedResult(error);
		return { status: "failed", code: "CONNECTION_FAILED", message: errorMessage(error) };
	}

	if (options.signal?.aborted) return abortedResult(options.signal.reason);
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { status: "success", bytes };
}

function cancelQuietly(resource: { cancel(): Promise<void> } | null): void {
	if (resource === null) return;
	try {
		void resource.cancel().catch(() => undefined);
	} catch {
		// Cleanup must not replace the read result.
	}
}

async function readWithSignal(
	reader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> },
	signal: AbortSignal | undefined,
): Promise<{ done: boolean; value?: Uint8Array }> {
	if (signal === undefined) return reader.read();
	if (signal.aborted) {
		cancelQuietly(reader);
		throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
	}
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			cancelQuietly(reader);
			reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
		};
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		signal.addEventListener("abort", onAbort, { once: true });
		void reader.read().then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				cleanup();
				reject(error);
			},
		);
	});
}

function abortedResult(error: unknown): ResponseBodyReadResult {
	return { status: "failed", code: "ABORTED", message: errorMessage(error) };
}

export function responseContentLength(headers: WebHttpHeaders): number | undefined {
	return contentLength(headers);
}

function contentLength(headers: WebHttpHeaders): number | undefined {
	const value = headers.get("content-length");
	if (value === null) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
