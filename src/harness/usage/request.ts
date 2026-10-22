import { UsageRequestError } from "./types.ts";

const MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 12_000;

export interface JsonRequestContext {
	fetchImpl: typeof fetch;
	signal: AbortSignal | undefined;
}

export interface JsonRequestOptions {
	timeoutMs?: number;
	headers?: Record<string, string>;
}

export class UsageHttpError extends Error {
	constructor(readonly status: number) {
		super(`http_${status}`);
		this.name = "UsageHttpError";
	}
}

export async function requestJson(
	url: string,
	token: string,
	context: JsonRequestContext,
	options: JsonRequestOptions & ({ method?: "GET"; body?: never } | { method: "POST"; body: Record<string, string> }) = {},
): Promise<unknown> {
	const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const signal = context.signal === undefined
		? timeoutSignal
		: AbortSignal.any([context.signal, timeoutSignal]);
	let response: Response;
	try {
		response = await context.fetchImpl(url, {
			signal,
			...(options.method === "POST" ? { method: "POST", body: JSON.stringify(options.body) } : {}),
			headers: {
				...options.headers, Authorization: `Bearer ${token}`, Accept: "application/json",
				...(options.method === "POST" ? { "Content-Type": "application/json" } : {}),
			},
			redirect: "error",
		});
	} catch {
		throw requestFailure(context.signal, timeoutSignal);
	}
	if (response.status < 200 || response.status >= 300) {
		await response.body?.cancel().catch(() => undefined);
		throw new UsageHttpError(response.status);
	}
	let text: string;
	try {
		text = await readBody(response, MAX_RESPONSE_BYTES);
	} catch (error) {
		if (error instanceof UsageRequestError) throw error;
		throw requestFailure(context.signal, timeoutSignal);
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new UsageRequestError("invalid_response");
	}
}

function requestFailure(parentSignal: AbortSignal | undefined, timeoutSignal: AbortSignal): UsageRequestError {
	if (parentSignal?.aborted) return new UsageRequestError("aborted");
	if (timeoutSignal.aborted) return new UsageRequestError("timeout");
	return new UsageRequestError("request_failed");
}

async function readBody(response: Response, maxBytes: number): Promise<string> {
	if (response.body === null) return "";
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let bytes = 0;
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) break;
		bytes += chunk.value.byteLength;
		if (bytes > maxBytes) {
			await reader.cancel().catch(() => undefined);
			throw new UsageRequestError("response_too_large");
		}
		chunks.push(Buffer.from(chunk.value));
	}
	return Buffer.concat(chunks, bytes).toString("utf8");
}
