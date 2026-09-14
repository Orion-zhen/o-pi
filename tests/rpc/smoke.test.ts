import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useTempDir } from "../helpers/lifecycle.ts";

const running = new Set<ChildProcessWithoutNullStreams>();
const temp = useTempDir("opi-rpc-");

afterEach(() => {
	for (const child of running) {
		child.stdin.end();
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
	}
	running.clear();
});

describe("真实 opi 二进制 RPC", () => {
	it("离线完成 state、静态 commands、工具事件和干净 shutdown", async () => {
		const presenceConfig = path.join(temp.path, "discord-presence.jsonc");
		await writeFile(presenceConfig, '{"enabled":false}');
		const cliPath = path.resolve(process.platform === "win32" ? "dist/opi.exe" : "dist/opi");
		const child = spawn(cliPath, [
			"--mode",
			"rpc",
			"--no-session",
			"--offline",
			"--approve",
		], {
			cwd: temp.path,
			env: { PATH: process.env.PATH, HOME: temp.path, USERPROFILE: temp.path, SystemRoot: process.env.SystemRoot,
				PI_CODING_AGENT_DIR: path.join(temp.path, "agent"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1",
				PI_DISCORD_PRESENCE_CONFIG: presenceConfig },
			stdio: ["pipe", "pipe", "pipe"],
		});
		running.add(child);
		const client = createRpcClient(child);

		client.send({ id: "state", type: "get_state" });
		const state = await client.waitFor((message) => isResponse(message, "state", "get_state"));
		expect(state["success"]).toBe(true);
		expect(state["data"]).toMatchObject({ isStreaming: false, messageCount: 0 });

		client.send({ id: "commands", type: "get_commands" });
		const commands = await client.waitFor((message) => isResponse(message, "commands", "get_commands"));
		expect(commands["success"]).toBe(true);
		for (const command of ["tools", "system", "stats", "prune", "run", "usage", "presence"]) {
			expect(commandNames(commands)).toContain(command);
		}

		client.send({ id: "presence", type: "prompt", message: "/presence status" });
		const presence = await client.waitFor((message) => (
			message["type"] === "extension_ui_request" && message["method"] === "notify"
		));
		expect(presence["message"]).toContain("Discord presence: off");
		const presenceResponse = await client.waitFor((message) => isResponse(message, "presence", "prompt"));
		expect(presenceResponse["success"]).toBe(true);

		client.send({ id: "bash", type: "bash", command: "printf rpc-tool-smoke" });
		const bashUpdate = await client.waitFor((message) => (
			message["type"] === "bash_execution_update"
			&& message["id"] === "bash"
		));
		expect(bashUpdate["delta"]).toBe("rpc-tool-smoke");
		const bashResponse = await client.waitFor((message) => isResponse(message, "bash", "bash"));
		expect(bashResponse["success"]).toBe(true);
		expect(bashResponse["data"]).toMatchObject({
			output: "rpc-tool-smoke",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});

		client.send({ id: "final-state", type: "get_state" });
		const finalState = await client.waitFor((message) => isResponse(message, "final-state", "get_state"));
		expect(finalState["data"]).toMatchObject({ isStreaming: false, messageCount: 1 });
		expect(client.messages.some((message) => message["type"] === "extension_error")).toBe(false);

		child.stdin.end();
		const exit = await client.waitForExit();
		running.delete(child);
		expect(exit).toEqual({ code: 0, signal: null });
		expect(client.protocolErrors).toEqual([]);
		expect(client.stderr).toBe("");
	}, 30_000);
});

interface RpcClient {
	messages: Record<string, unknown>[];
	protocolErrors: string[];
	readonly stderr: string;
	send(message: Record<string, unknown>): void;
	waitFor(predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
	waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function createRpcClient(child: ChildProcessWithoutNullStreams): RpcClient {
	const messages: Record<string, unknown>[] = [];
	const protocolErrors: string[] = [];
	const waiters = new Set<{
		predicate: (message: Record<string, unknown>) => boolean;
		resolve(message: Record<string, unknown>): void;
	}>();
	let stdoutBuffer = "";
	let stderr = "";

	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdoutBuffer += chunk;
		while (true) {
			const newline = stdoutBuffer.indexOf("\n");
			if (newline < 0) break;
			const line = stdoutBuffer.slice(0, newline);
			stdoutBuffer = stdoutBuffer.slice(newline + 1);
			if (line === "") continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch (error) {
				protocolErrors.push(error instanceof Error ? error.message : String(error));
				continue;
			}
			if (!isRecord(parsed)) {
				protocolErrors.push(`non-object RPC message: ${line}`);
				continue;
			}
			messages.push(parsed);
			for (const waiter of [...waiters]) {
				if (!waiter.predicate(parsed)) continue;
				waiters.delete(waiter);
				waiter.resolve(parsed);
			}
		}
	});
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});

	const waitFor = (predicate: (message: Record<string, unknown>) => boolean) => {
		const existing = messages.find(predicate);
		if (existing !== undefined) return Promise.resolve(existing);
		return withDeadline(new Promise<Record<string, unknown>>((resolve) => {
			waiters.add({ predicate, resolve });
		}), 15_000, "RPC message");
	};
	const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => resolve({ code, signal }));
	});

	return {
		messages,
		protocolErrors,
		get stderr() {
			return stderr;
		},
		send(message) {
			child.stdin.write(`${JSON.stringify(message)}\n`);
		},
		waitFor,
		waitForExit: () => withDeadline(exitPromise, 15_000, "RPC shutdown"),
	};
}

function isResponse(message: Record<string, unknown>, id: string, command: string): boolean {
	return message["type"] === "response" && message["id"] === id && message["command"] === command;
}

function commandNames(response: Record<string, unknown>): string[] {
	assert.equal(response["success"], true);
	const data = response["data"];
	assert(isRecord(data) && Array.isArray(data["commands"]));
	return data["commands"].map((command: unknown) => {
		assert(isRecord(command) && typeof command["name"] === "string");
		return command["name"];
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withDeadline<T>(promise: Promise<T>, durationMs: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} timed out after ${durationMs}ms`)), durationMs);
		void promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}
