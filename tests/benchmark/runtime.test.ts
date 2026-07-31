import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface BenchmarkRuntime {
	measureInteractiveReady(
		command: string,
		args: string[],
		options: { warmups: number; runs: number; readyMarker: string; timeoutMs?: number },
	): Promise<number[]>;
	scriptArgs(command: string, args: string[], platform?: NodeJS.Platform): string[];
}

const runtimeUrl = new URL("../../scripts/benchmark/runtime.mjs", import.meta.url);
const { measureInteractiveReady, scriptArgs } = await import(runtimeUrl.href) as BenchmarkRuntime;

describe("benchmark interactive runtime", () => {
	it.each([
		["darwin", ["-q", "/dev/null", "/path/pi", "--label", "a b"]],
		["linux", ["-qfec", "'/path/pi' '--label' 'a b'", "/dev/null"]],
	] as const)("为 %s 生成 script 参数", (platform, expected) => {
		expect(scriptArgs("/path/pi", ["--label", "a b"], platform)).toEqual(expected);
	});

	it.skipIf(!existsSync("/usr/bin/script"))("通过伪终端检测就绪标记", async () => {
		const samples = await measureInteractiveReady(process.execPath, [
			"-e",
			"console.log(\"benchmark-ready\"); setInterval(() => {}, 1000)",
		], { warmups: 0, runs: 1, readyMarker: "benchmark-ready", timeoutMs: 5_000 });

		expect(samples).toHaveLength(1);
		expect(samples[0]).toBeGreaterThanOrEqual(0);
	});
});
