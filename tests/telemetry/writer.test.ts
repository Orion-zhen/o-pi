import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { CallRecord, RunRecord } from "../../src/telemetry/types.js";
import { JsonlTelemetryWriter, telemetryRunFile } from "../../src/telemetry/writer.js";
import { useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("pi-telemetry-writer-");

describe("JSONL telemetry writer", () => {
	it("writes ordered, private run files", async () => {
		const directory = path.join(temp.path, "runs");
		const writer = await JsonlTelemetryWriter.open("run-1", { directory });
		const first = run("run-1");
		const second = { ...first, at: new Date(1).toISOString() };
		expect(writer.append(first)).toBe(true);
		expect(writer.append(second)).toBe(true);
		await writer.close();
		const file = telemetryRunFile("run-1", directory);
		expect((await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line))).toEqual([first, second]);
		expect(writer.status()).toEqual({ enabled: false, written: 2 });
	});

	it("持久化 repair fanout 摘要而不写入原始参数", async () => {
		const directory = path.join(temp.path, "fanout");
		const writer = await JsonlTelemetryWriter.open("run-fanout", { directory });
		const record: CallRecord = {
			type: "call",
			run_id: "run-fanout",
			at: new Date(0).toISOString(),
			call_id: "call-1",
			call_index: 0,
			tool: "find",
			started_at: new Date(0).toISOString(),
			ended_at: new Date(1).toISOString(),
			duration_ms: 1,
			status: "success",
			repair: { status: "repaired", operations: ["split_path_list"], fanout: { field: "path", count: 2, separator: "whitespace" } },
		};
		expect(writer.append(record)).toBe(true);
		await writer.close();
		const lines = (await readFile(telemetryRunFile("run-fanout", directory), "utf8")).trim().split("\n");
		expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ repair: { fanout: { field: "path", count: 2, separator: "whitespace" } } });
		expect(JSON.stringify(record)).not.toContain("rawArgs");
	});

	it("disables once after a stream error", async () => {
		const errors: unknown[] = [];
		const stream = new FakeWriteStream();
		const writer = await JsonlTelemetryWriter.open("run", {
			directory: path.join(temp.path, "fake"),
			onError: (error) => errors.push(error),
			createStream: () => fixture(stream),
		});
		const failure = new Error("disk full");
		stream.emit("error", failure);
		expect(writer.append(run("run"))).toBe(false);
		expect(errors).toEqual([failure]);
	});

	it("hashes unsafe run ids", () => {
		expect(telemetryRunFile("../escape", "/safe")).toMatch(/^\/safe\/invalid-[a-f0-9]{64}\.jsonl$/u);
	});
});

class FakeWriteStream extends EventEmitter {
	destroyed = false;
	write(): boolean { return true; }
	end(): void { this.destroyed = true; this.emit("finish"); this.emit("close"); }
}

function run(id: string): RunRecord {
	return { type: "run", run_id: id, at: new Date(0).toISOString(), session_id: "session", reason: "startup", cwd: "/repo" };
}

function fixture<T>(value: unknown): T {
	return value as T;
}
