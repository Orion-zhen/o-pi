import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

vi.mock("../../src/worker-runtime/typescript-worker.js", async () => {
	const { Worker } = await import("node:worker_threads");
	return {
		createTypeScriptWorker: () => new Worker([
			"const { parentPort } = require('node:worker_threads');",
			"parentPort.on('message', () => { throw new Error('simulated grep worker failure'); });",
		].join("\n"), { eval: true }),
	};
});

import { clearGrepTestRuntime, grepWorkspaceFiles } from "../helpers/grep-tool.js";

const workspaceTemp = useTempDir("o-pi-grep-worker-fallback-");
const configTemp = useTempDir("o-pi-grep-worker-fallback-config-");
preserveEnv("PI_FILE_TOOLS_CONFIG");

beforeEach(async () => {
	clearGrepTestRuntime();
	const configPath = path.join(configTemp.path, "file-tools.jsonc");
	process.env.PI_FILE_TOOLS_CONFIG = configPath;
	await writeFile(configPath, JSON.stringify({
		blocked_path: [".git/"],
		ignored_path: [],
		ignore: { builtin_profile: "none", gitignore: false },
		limits: { grep_ast_max_file_bytes: 300_000 },
	}));
});

afterEach(() => {
	clearGrepTestRuntime();
});

describe("grep worker fallback", () => {
	it("worker 非取消异常后不在主线程重试，并保留 verified 文本命中", async () => {
		const prefix = "export function WorkerNeedle() { return true; }\n";
		const content = prefix + " ".repeat(262_144 - Buffer.byteLength(prefix));
		await writeFile(path.join(workspaceTemp.path, "worker.ts"), content);

		const result = await grepWorkspaceFiles(workspaceTemp.path, { query: "WorkerNeedle" });

		expect(result).toMatchObject({
			status: "success",
			stats: { parsed_files: 0 },
			regions: [expect.objectContaining({
				path: "worker.ts",
				kind: "text",
				query_match: "verified",
				match_lines: [1],
			})],
		});
	});
});
