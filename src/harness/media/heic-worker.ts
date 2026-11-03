import { parentPort } from "node:worker_threads";
import { createCanvas, ImageData } from "@napi-rs/canvas";
import { decodeHeic } from "./heic-decode.ts";
import type { HeicPngResult } from "./heic.ts";
import type { WorkerTaskRequest, WorkerTaskResponse } from "../worker-runtime/worker-task-pool.ts";

if (parentPort === null) throw new Error("HEIC worker requires a parent port");
const port = parentPort;
port.on("message", async ({ id, request }: WorkerTaskRequest<Uint8Array>) => {
	let response: WorkerTaskResponse<HeicPngResult>;
	try {
		const image = await decodeHeic(request);
		if ("error" in image) {
			response = { id, result: image };
		} else {
			const canvas = createCanvas(image.width, image.height);
			canvas.getContext("2d").putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
			const bytes = new Uint8Array(await canvas.encode("png"));
			response = { id, result: { bytes, imageCount: image.imageCount } };
		}
	} catch (error) {
		response = { id, error: error instanceof Error ? error.message : String(error) };
	}
	port.postMessage(response);
});
