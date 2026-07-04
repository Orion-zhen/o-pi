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
	if (expected !== undefined && expected > options.maxBytes) {
		await response.body?.cancel();
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
			const { done, value } = await reader.read();
			if (done) break;
			if (value === undefined) continue;
			total += value.byteLength;
			if (total > options.maxBytes) {
				await reader.cancel();
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
		if (options.signal?.aborted) {
			return { status: "failed", code: "ABORTED", message: errorMessage(error) };
		}
		return { status: "failed", code: "CONNECTION_FAILED", message: errorMessage(error) };
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { status: "success", bytes };
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
