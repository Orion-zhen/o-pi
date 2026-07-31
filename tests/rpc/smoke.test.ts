import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<ChildProcessWithoutNullStreams>();

afterEach(() => {
	for (const child of running) {
		child.stdin.end();
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
	}
	running.clear();
});

describe("真实 Pi RPC", () => {
	it("离线完成 state、commands、工具事件、extension UI 往返和干净 shutdown", async () => {
		const cliPath = path.resolve("node_modules/.bin/pi");
		const extensionPath = path.resolve("tests/rpc/fixtures/dialog-extension.ts");
		const child = spawn(cliPath, [
			"--mode",
			"rpc",
			"--no-session",
			"--offline",
			"--approve",
			"--extension",
			extensionPath,
		], {
			cwd: process.cwd(),
			env: { ...process.env, PI_OFFLINE: "1" },
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
		expect(commandNames(commands)).toEqual(expect.arrayContaining([
			"rpc-dialog-smoke",
			"stats",
			"usage",
			"run",
		]));

		client.send({ id: "dialog", type: "prompt", message: "/rpc-dialog-smoke" });
		const request = await client.waitFor((message) => (
			message["type"] === "extension_ui_request"
			&& message["method"] === "confirm"
			&& message["title"] === "RPC smoke"
		));
		const requestId = request["id"];
		if (typeof requestId !== "string") throw new Error("RPC dialog request id missing");
		client.send({ type: "extension_ui_response", id: requestId, confirmed: true });

		const prompt = await client.waitFor((message) => isResponse(message, "dialog", "prompt"));
		expect(prompt["success"]).toBe(true);
		const notification = await client.waitFor((message) => (
			message["type"] === "extension_ui_request"
			&& message["method"] === "notify"
			&& message["message"] === "rpc-dialog-smoke:confirmed"
		));
		expect(notification["notifyType"]).toBe("info");

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
	const data = response["data"];
	if (!isRecord(data) || !Array.isArray(data["commands"])) return [];
	return data["commands"].flatMap((command) => (
		isRecord(command) && typeof command["name"] === "string" ? [command["name"]] : []
	));
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
