import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";

import type { TelemetryRecord } from "./types.ts";

/** 每次运行独占一个按序追加的文件。 */
export class JsonlTelemetryWriter {
	readonly #stream: WriteStream;
	readonly #onError: (error: unknown) => void;
	#enabled = true;
	#closed = false;

	private constructor(stream: WriteStream, onError: (error: unknown) => void) {
		this.#stream = stream;
		this.#onError = onError;
		stream.on("error", (error) => this.disable(error));
	}

	static async open(runId: string, onError: (error: unknown) => void): Promise<JsonlTelemetryWriter> {
		const directory = path.join(os.homedir(), ".pi", "telemetry", "runs");
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const stream = createWriteStream(path.join(directory, `${runId}.jsonl`), {
			flags: "wx",
			encoding: "utf8",
			mode: 0o600,
		});
		return new JsonlTelemetryWriter(stream, onError);
	}

	append(record: TelemetryRecord): boolean {
		if (!this.#enabled || this.#closed) return false;
		try {
			this.#stream.write(`${JSON.stringify(record)}\n`);
			return true;
		} catch (error) {
			this.disable(error);
			return false;
		}
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		if (!this.#stream.destroyed) this.#stream.end();
		await finished(this.#stream).catch((error: unknown) => this.disable(error));
	}

	private disable(error: unknown): void {
		if (!this.#enabled) return;
		this.#enabled = false;
		try {
			this.#onError(error);
		} catch {
			// Telemetry diagnostics cannot escape the writer boundary.
		}
	}
}
