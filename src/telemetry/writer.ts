import { mkdir, open } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { lock } from "proper-lockfile";
import type { TelemetryRecord } from "./types.js";

const emergencySequences = new Map<string, number>();
let emergencyQueue: Promise<void> = Promise.resolve();

export interface TelemetryWriter {
	append(record: TelemetryRecord): void;
	flush(): Promise<void>;
	status?(): TelemetryWriterStatus;
}

export interface TelemetryWriterStatus {
	pending: number;
	persisted: number;
	failed: number;
	health_persisted: number;
	health_failed: number;
	dropped: number;
	last_failure_at?: string;
}

export interface JsonlTelemetryWriterOptions {
	directory?: string;
	runId?: string;
	append?: (file: string, content: string) => Promise<void>;
	appendHealth?: (file: string, content: string) => Promise<void>;
	acquireLock?: (file: string) => Promise<() => Promise<void>>;
	maxPending?: number;
}

export class JsonlTelemetryWriter implements TelemetryWriter {
	readonly #file: string;
	readonly #healthFile: string;
	readonly #directory: string;
	readonly #append: (file: string, content: string) => Promise<void>;
	readonly #appendHealth: (file: string, content: string) => Promise<void>;
	readonly #acquireLock: (file: string) => Promise<() => Promise<void>>;
	readonly #maxPending: number;
	#queue: Promise<void> = Promise.resolve();
	readonly #batch: Array<{ record: TelemetryRecord; line: string }> = [];
	#batchQueued = false;
	#pending = 0;
	#persisted = 0;
	#failed = 0;
	#healthPersisted = 0;
	#healthFailed = 0;
	#dropped = 0;
	#healthSequence = 0;
	#overflowHealthQueued = false;
	#lastFailureAt: string | undefined;

	constructor(sessionId: string, options: JsonlTelemetryWriterOptions = {}) {
		this.#directory = options.directory ?? path.join(os.homedir(), ".pi", "telemetry", "sessions");
		const runId = options.runId ?? randomUUID();
		this.#file = telemetrySessionFile(sessionId, runId, this.#directory);
		this.#healthFile = telemetryHealthFile(sessionId, runId, this.#directory);
		this.#append = options.append ?? durableAppend;
		this.#appendHealth = options.appendHealth ?? durableAppend;
		this.#acquireLock = options.acquireLock ?? acquireTelemetryFileLock;
		this.#maxPending = options.maxPending ?? 10_000;
	}

	append(record: TelemetryRecord): void {
		if (this.#pending >= this.#maxPending) {
			this.#failed += 1;
			this.#dropped += 1;
			this.#lastFailureAt = new Date().toISOString();
			if (!this.#overflowHealthQueued) {
				this.#overflowHealthQueued = true;
				this.queueHealth(record, Object.assign(new Error("Telemetry writer queue capacity exceeded"), { code: "TELEMETRY_BACKPRESSURE" }));
			}
			return;
		}
		let line: string;
		try {
			line = `${JSON.stringify(record)}\n`;
		} catch (error) {
			this.#failed += 1;
			this.#lastFailureAt = new Date().toISOString();
			this.queueHealth(record, error);
			return;
		}
		this.#pending += 1;
		this.#batch.push({ record, line });
		this.queueBatch();
	}

	async flush(): Promise<void> {
		await this.#queue.catch(() => undefined);
	}

	status(): TelemetryWriterStatus {
		return {
			pending: this.#pending,
			persisted: this.#persisted,
			failed: this.#failed,
			health_persisted: this.#healthPersisted,
			health_failed: this.#healthFailed,
			dropped: this.#dropped,
			...(this.#lastFailureAt === undefined ? {} : { last_failure_at: this.#lastFailureAt }),
		};
	}

	private queueHealth(record: TelemetryRecord, error: unknown): void {
		this.#pending += 1;
		this.#queue = this.#queue.then(async () => {
			try {
				await this.persistHealth(record, error);
			} finally {
				this.#pending -= 1;
				this.#overflowHealthQueued = false;
			}
		});
	}

	private queueBatch(): void {
		if (this.#batchQueued) return;
		this.#batchQueued = true;
		this.#queue = this.#queue.then(async () => {
			const batch = this.#batch.splice(0);
			this.#batchQueued = false;
			if (batch.length === 0) return;
			try {
				await mkdir(this.#directory, { recursive: true, mode: 0o700 });
				const release = await this.#acquireLock(this.#file);
				try {
					await this.#append(this.#file, batch.map((entry) => entry.line).join(""));
				} finally {
					await release();
				}
				this.#persisted += batch.length;
			} catch (error) {
				this.#failed += batch.length;
				this.#lastFailureAt = new Date().toISOString();
				for (const entry of batch) await this.persistHealth(entry.record, error);
			} finally {
				this.#pending -= batch.length;
			}
		});
	}

	private async persistHealth(record: TelemetryRecord, error: unknown): Promise<void> {
		const timestamp = new Date().toISOString();
		const health = {
			event: "collection_health",
			id: randomUUID(),
			timestamp,
			session_id: record.session_id,
			run_id: record.run_id,
			collector_contract_hash: record.collector_contract_hash,
			stream_id: "health",
			sequence: this.#healthSequence++,
			context: record.context,
			data: {
				issue: "writer_failure",
				details: {
					failed_event_id: record.id,
					failed_event: record.event,
					failed_sequence: record.sequence,
					...errorIdentity(error),
				},
			},
		};
		try {
			await mkdir(this.#directory, { recursive: true, mode: 0o700 });
			const release = await this.#acquireLock(this.#healthFile);
			try {
				await this.#appendHealth(this.#healthFile, `${JSON.stringify(health)}\n`);
			} finally {
				await release();
			}
			this.#healthPersisted += 1;
		} catch {
			this.#healthFailed += 1;
		}
	}
}

export async function flushEmergencyHealth(): Promise<void> {
	await emergencyQueue;
}

export async function acquireTelemetryFileLock(file: string): Promise<() => Promise<void>> {
	return lock(file, {
		realpath: false,
		stale: 10_000,
		retries: {
			retries: 20,
			factor: 1.5,
			minTimeout: 5,
			maxTimeout: 50,
			randomize: true,
		},
	});
}

export function telemetrySessionFile(sessionId: string, runId: string, directory = path.join(os.homedir(), ".pi", "telemetry", "sessions")): string {
	return path.join(directory, `${safeTelemetryFileName(sessionId)}.${safeTelemetryFileName(runId)}.jsonl`);
}

export function telemetryHealthFile(sessionId: string, runId: string, directory = path.join(os.homedir(), ".pi", "telemetry", "sessions")): string {
	return path.join(directory, `${safeTelemetryFileName(sessionId)}.${safeTelemetryFileName(runId)}.health.jsonl`);
}

export function safeTelemetryFileName(sessionId: string): string {
	const prefix = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "unknown";
	const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
	return `${prefix}-${digest}`;
}

function errorIdentity(error: unknown): Record<string, string> {
	if (!(error instanceof Error)) return { error_name: "unknown" };
	const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
	return { error_name: error.name || "Error", ...(code === undefined ? {} : { error_code: code }) };
}

export function writeEmergencyHealth(input: {
	sessionId: string;
	runId: string;
	collectorContractHash: string;
	issue: string;
	error: unknown;
	directory?: string;
}): void {
	const directory = input.directory ?? path.join(os.homedir(), ".pi", "telemetry", "sessions");
	const file = path.join(directory, `emergency.${safeTelemetryFileName(input.runId)}.health.jsonl`);
	const sequence = emergencySequences.get(input.runId) ?? 0;
	emergencySequences.set(input.runId, sequence + 1);
	const record = {
		event: "collection_health", id: randomUUID(), timestamp: new Date().toISOString(), session_id: input.sessionId,
			run_id: input.runId, stream_id: "emergency", collector_contract_hash: input.collectorContractHash, sequence,
		context: { cwd: "unknown", host: { platform: process.platform, arch: process.arch, node_version: process.version } },
		data: { issue: input.issue, details: errorIdentity(input.error) },
	};
	emergencyQueue = emergencyQueue.then(async () => {
		try {
			await mkdir(directory, { recursive: true, mode: 0o700 });
			await durableAppend(file, `${JSON.stringify(record)}\n`);
		} catch {
			// This is the final best-effort boundary and must never reach Pi.
		}
	});
}

async function durableAppend(file: string, content: string): Promise<void> {
	const handle = await open(file, "a", 0o600);
	try {
		await handle.writeFile(content, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
}
