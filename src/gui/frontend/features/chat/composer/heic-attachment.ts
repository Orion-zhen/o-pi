export type HeicAttachmentResult = { blob: Blob; imageCount: number } | { error: string };

export async function convertHeicAttachment(file: File, signal: AbortSignal): Promise<HeicAttachmentResult> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	signal.throwIfAborted();
	const worker = new Worker(new URL("./heic-worker.ts", import.meta.url), { type: "module" });
	const { promise, resolve, reject } = Promise.withResolvers<HeicAttachmentResult>();
	const abort = () => reject(signal.reason);
	worker.onmessage = (event: MessageEvent<HeicAttachmentResult>) => resolve(event.data);
	worker.onerror = (event) => { event.preventDefault(); reject(new Error(event.message)); };
	signal.addEventListener("abort", abort, { once: true });
	try {
		worker.postMessage(bytes, [bytes.buffer]);
		return await promise;
	} finally {
		signal.removeEventListener("abort", abort);
		worker.terminate();
	}
}
