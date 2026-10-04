import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { telemetryRunsDirectory } from "../storage/paths.ts";
import { retainStoragePath } from "../storage/active.ts";
import path from "node:path";
import { finished } from "node:stream/promises";

import type { TelemetryRecord } from "./types.ts";

/** 每次运行独占一个按序追加的文件。 */
export class JsonlTelemetryWriter {
	readonly #stream: WriteStream;
	readonly #onError: (error: unknown) => void;
	#enabled = true;
	#closed = false;

	private constructor(stream: WriteStream, onError: (error: unknown) => void, private release: () => void) {
		this.#stream = stream;
		this.#onError = onError;
		stream.on("error", (error) => this.disable(error));
	}

	static async open(runId: string, onError: (error: unknown) => void): Promise<JsonlTelemetryWriter> {
		const directory = telemetryRunsDirectory();
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const file = path.join(directory, `${runId}.jsonl`);
		const stream = createWriteStream(file, {
			flags: "wx",
			encoding: "utf8",
			mode: 0o600,
		});
		return new JsonlTelemetryWriter(stream, onError, retainStoragePath(file));
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
		try { await finished(this.#stream).catch((error: unknown) => this.disable(error)); }
		finally { this.release(); }
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
