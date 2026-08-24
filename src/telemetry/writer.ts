import { createWriteStream, type WriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";

import type { TelemetryRecord } from "./types.js";

export interface TelemetryWriter {
	append(record: TelemetryRecord): boolean;
	close(): Promise<void>;
}

export interface JsonlTelemetryWriterOptions {
	directory?: string;
	onError?: (error: unknown) => void;
	createStream?: (file: string) => WriteStream;
}

/** One ordered append-only stream per run. Durability is delegated to the OS. */
export class JsonlTelemetryWriter implements TelemetryWriter {
	readonly #stream: WriteStream;
	readonly #onError: (error: unknown) => void;
	#enabled = true;
	#closed = false;

	private constructor(stream: WriteStream, onError: (error: unknown) => void) {
		this.#stream = stream;
		this.#onError = onError;
		stream.on("error", (error) => this.disable(error));
	}

	static async open(runId: string, options: JsonlTelemetryWriterOptions = {}): Promise<JsonlTelemetryWriter> {
		const directory = options.directory ?? path.join(os.homedir(), ".pi", "telemetry", "runs");
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const file = telemetryRunFile(runId, directory);
		const stream = options.createStream?.(file) ?? createWriteStream(file, {
			flags: "wx",
			encoding: "utf8",
			mode: 0o600,
		});
		return new JsonlTelemetryWriter(stream, options.onError ?? (() => undefined));
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

export function telemetryRunFile(runId: string, directory = path.join(os.homedir(), ".pi", "telemetry", "runs")): string {
	return path.join(directory, `${safeRunId(runId)}.jsonl`);
}

function safeRunId(runId: string): string {
	return /^[A-Za-z0-9._-]{1,128}$/u.test(runId)
		? runId
		: `invalid-${createHash("sha256").update(runId).digest("hex")}`;
}
