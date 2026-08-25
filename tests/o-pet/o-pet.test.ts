import { chmod } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOPetEventHandlers, createOPetExtension } from "../../agent/extensions/o-pet.js";
import {
	connectOPetSocket,
	OPetClient,
	type OPetConnector,
	type OPetEventClient,
	type OPetSocket,
	type OPetSocketCallbacks,
} from "../../src/o-pet/client.js";
import {
	defaultOPetEndpoint,
	prepareOPetEndpoint,
	resolveOPetEndpoint,
} from "../../src/o-pet/endpoint.js";
import { serializeOPetMessage, type OPetEvent } from "../../src/o-pet/protocol.js";
import { OPetService } from "../../src/o-pet/service.js";
import { deferredVoid } from "../helpers/async.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-o-pet-");
preserveEnv("O_PET_ENDPOINT", "XDG_RUNTIME_DIR");

afterEach(() => {
	vi.useRealTimers();
});

describe("o-pet 协议与端点", () => {
	it("写出状态事件 JSON Lines", () => {
		const serialized = [
			serializeOPetMessage({ type: "hello", clientId: "client-1", sessionId: "session-1" }),
			serializeOPetMessage({ type: "event", event: { type: "thinking_started" } }),
			serializeOPetMessage({ type: "event", event: { type: "reply_started" } }),
			serializeOPetMessage({
				type: "event",
				event: { type: "tool_observed", toolName: "skill" },
			}),
			serializeOPetMessage({
				type: "event",
				event: { type: "tool_started", toolCallId: "tool-1", toolName: "skill" },
			}),
			serializeOPetMessage({
				type: "event",
				event: { type: "tool_progressed", toolCallId: "tool-1" },
			}),
			serializeOPetMessage({
				type: "event",
				event: { type: "approval_requested", toolCallId: "tool-1", toolName: "skill" },
			}),
			serializeOPetMessage({
				type: "event",
				event: { type: "approval_resolved", toolCallId: "tool-1", outcome: "approved" },
			}),
			serializeOPetMessage({ type: "event", event: { type: "reply_finished" } }),
			serializeOPetMessage({
				type: "event",
				event: { type: "agent_settled", outcome: "success", durationMs: 1200 },
			}),
			serializeOPetMessage({ type: "goodbye" }),
		].join("");
		const expected = [
			'{"type":"hello","clientId":"client-1","sessionId":"session-1"}',
			'{"type":"event","event":{"type":"thinking_started"}}',
			'{"type":"event","event":{"type":"reply_started"}}',
			'{"type":"event","event":{"type":"tool_observed","toolName":"skill"}}',
			'{"type":"event","event":{"type":"tool_started","toolCallId":"tool-1","toolName":"skill"}}',
			'{"type":"event","event":{"type":"tool_progressed","toolCallId":"tool-1"}}',
			'{"type":"event","event":{"type":"approval_requested","toolCallId":"tool-1","toolName":"skill"}}',
			'{"type":"event","event":{"type":"approval_resolved","toolCallId":"tool-1","outcome":"approved"}}',
			'{"type":"event","event":{"type":"reply_finished"}}',
			'{"type":"event","event":{"type":"agent_settled","outcome":"success","durationMs":1200}}',
			'{"type":"goodbye"}',
		].join("\n") + "\n";
		expect(serialized).toBe(expected);
		expect(serialized).not.toContain("protocolVersion");
	});

	it("优先使用显式端点覆盖", () => {
		process.env.O_PET_ENDPOINT = path.join(temp.path, "custom.sock");
		expect(resolveOPetEndpoint()).toBe(process.env.O_PET_ENDPOINT);
	});

	it.skipIf(process.platform !== "linux")("Linux 默认使用 XDG runtime 端点", () => {
		process.env.XDG_RUNTIME_DIR = temp.path;
		delete process.env.O_PET_ENDPOINT;
		expect(defaultOPetEndpoint()).toBe(path.join(temp.path, "o-pet.sock"));
		delete process.env.XDG_RUNTIME_DIR;
		expect(() => defaultOPetEndpoint()).toThrow("XDG_RUNTIME_DIR");
	});

	it.skipIf(process.platform === "win32")("创建私有端点目录并拒绝宽松权限", async () => {
		const privateEndpoint = path.join(temp.path, "private", "o-pet.sock");
		await expect(prepareOPetEndpoint(privateEndpoint)).resolves.toBeUndefined();

		await chmod(temp.path, 0o755);
		await expect(prepareOPetEndpoint(path.join(temp.path, "unsafe.sock")))
			.rejects.toThrow("only be accessible");
	});
});

describe("o-pet 客户端", () => {
	it.skipIf(process.platform === "win32")("服务端后启动时重放状态事件，并完成 hello 和 goodbye", async () => {
		const endpoint = path.join(temp.path, "pet.sock");
		let firstFailure!: () => void;
		const failed = new Promise<void>((resolve) => { firstFailure = resolve; });
		const connector: OPetConnector = (target, callbacks) => connectOPetSocket(target, {
			...callbacks,
			error(error) {
				callbacks.error(error);
				firstFailure();
			},
		});
		const client = new OPetClient({ endpoint, clientId: "client-1", connector });
		client.startSession("session-1");
		client.publish({ type: "turn_started" });
		await failed;

		const received: Record<string, unknown>[] = [];
		const sockets = new Set<Socket>();
		const server = createServer((socket) => {
			sockets.add(socket);
			socket.once("close", () => sockets.delete(socket));
			readJsonLines(socket, (message) => {
				received.push(message);
			});
		});
		await listen(server, endpoint);
		try {
			client.publish({ type: "tool_started", toolCallId: "read-1", toolName: "read" });
			await vi.waitFor(() => expect(received).toHaveLength(3));
			expect(received).toEqual([
				{ type: "hello", clientId: "client-1", sessionId: "session-1" },
				{ type: "event", event: { type: "turn_started" } },
				{
					type: "event",
					event: { type: "tool_started", toolCallId: "read-1", toolName: "read" },
				},
			]);
			client.shutdown();
			await vi.waitFor(() => expect(received).toHaveLength(4));
			expect(received[3]).toEqual({ type: "goodbye" });
		} finally {
			client.shutdown();
			for (const socket of sockets) socket.destroy();
			await closeServer(server);
		}
	});

	it("背压期间按序保留状态变化，断线不创建重连 timer", async () => {
		vi.useFakeTimers();
		const sockets: FakeSocket[] = [];
		const connector: OPetConnector = (_endpoint, callbacks) => {
			const socket = new FakeSocket(callbacks);
			sockets.push(socket);
			queueMicrotask(() => callbacks.connect());
			return socket;
		};
		const client = new OPetClient({
			endpoint: "fake-endpoint",
			clientId: "client",
			connector,
			prepareEndpoint: async () => undefined,
		});
		client.startSession("session");
		await flushMicrotasks();
		const socket = sockets[0];
		if (socket === undefined) throw new Error("fake socket missing");
		expect(socket.writes[0]).toContain('"type":"hello"');

		socket.acceptWrites = false;
		client.publish({ type: "turn_started" });
		client.publish({ type: "tool_started", toolCallId: "read-1", toolName: "read" });
		client.publish({
			type: "tool_finished", toolCallId: "read-1", outcome: "success",
		});
		expect(socket.writes).toHaveLength(2);
		socket.acceptWrites = true;
		socket.callbacks.drain();
		expect(socket.writes).toHaveLength(3);
		expect(socket.writes[2]).toBe(
			'{"type":"event","event":{"type":"tool_started","toolCallId":"read-1","toolName":"read"}}\n'
			+ '{"type":"event","event":{"type":"tool_finished","toolCallId":"read-1","outcome":"success"}}\n',
		);

		socket.callbacks.error(new Error("disconnected"));
		client.publish({ type: "agent_settled", outcome: "success", durationMs: 1 });
		await flushMicrotasks();
		expect(sockets).toHaveLength(2);
		expect(vi.getTimerCount()).toBe(0);
		client.shutdown();
		expect(sockets[1]?.endedWith).toBe('{"type":"goodbye"}\n');
	});

	it("尚未连接时 shutdown 直接销毁连接尝试", async () => {
		let socket: FakeSocket | undefined;
		const client = new OPetClient({
			endpoint: "pending",
			prepareEndpoint: async () => undefined,
			connector: (_endpoint, callbacks) => {
				socket = new FakeSocket(callbacks);
				return socket;
			},
		});
		client.startSession("session");
		await flushMicrotasks();
		client.shutdown();
		expect(socket?.destroyed).toBe(true);
		expect(socket?.endedWith).toBeUndefined();
	});

	it("端点准备期间 shutdown 不会创建连接", async () => {
		const preparation = deferredVoid();
		let connectionCount = 0;
		const client = new OPetClient({
			endpoint: "pending",
			prepareEndpoint: () => preparation.promise,
			connector: (_endpoint, callbacks) => {
				connectionCount += 1;
				return new FakeSocket(callbacks);
			},
		});
		client.startSession("session");
		client.shutdown();
		preparation.resolve();
		await flushMicrotasks();
		expect(connectionCount).toBe(0);
	});

	it("端点准备失败不会抛到调用方", async () => {
		const client = new OPetClient({
			endpoint: "invalid",
			prepareEndpoint: async () => { throw new Error("blocked"); },
		});
		expect(() => client.startSession("session")).not.toThrow();
		await flushMicrotasks();
		expect(() => client.publish({ type: "turn_started" })).not.toThrow();
	});
});

describe("o-pet 服务与 Pi 扩展", () => {
	it("发布工作阶段、节流后的工具进度和运行时长", () => {
		let now = 100;
		const client = new FakeEventClient();
		const service = new OPetService({ client, now: () => now });
		service.startSession("session");
		service.onAgentStart();
		service.onTurnStart();
		service.onThinkingStart();
		service.onReplyStart();
		service.onReplyEnd();
		service.onToolObserved("read");
		service.onToolStart("read-1", "read");
		service.onToolProgress("read-1");
		now = 200;
		service.onToolProgress("read-1");
		now = 1_600;
		service.onToolProgress("read-1");
		service.onToolEnd("read-1", false);
		service.onToolStart("bash-1", "bash");
		service.onApprovalRequested("bash-1", "bash");
		service.onApprovalResolved("bash-1", "denied");
		service.onToolEnd("bash-1", true);
		now = 2_100;
		service.onAgentSettled();
		expect(client.events).toEqual([
			{ type: "agent_started" },
			{ type: "turn_started" },
			{ type: "thinking_started" },
			{ type: "reply_started" },
			{ type: "reply_finished" },
			{ type: "tool_observed", toolName: "read" },
			{ type: "tool_started", toolCallId: "read-1", toolName: "read" },
			{ type: "tool_progressed", toolCallId: "read-1" },
			{ type: "tool_progressed", toolCallId: "read-1" },
			{ type: "tool_finished", toolCallId: "read-1", outcome: "success" },
			{ type: "tool_started", toolCallId: "bash-1", toolName: "bash" },
			{ type: "approval_requested", toolCallId: "bash-1", toolName: "bash" },
			{ type: "approval_resolved", toolCallId: "bash-1", outcome: "denied" },
			{ type: "tool_finished", toolCallId: "bash-1", outcome: "error" },
			{ type: "agent_settled", outcome: "success", durationMs: 2_000 },
		]);
	});

	it.each(["error", "aborted"] as const)("保留 assistant %s 作为 settled 结果", (outcome) => {
		let now = 0;
		const client = new FakeEventClient();
		const service = new OPetService({ client, now: () => now });
		service.startSession("session");
		service.onAgentStart();
		service.onTurnStart();
		service.onMessageEnd(outcome);
		now = 120;
		service.onAgentSettled();
		expect(client.events.at(-1)).toEqual({ type: "agent_settled", outcome, durationMs: 120 });
		service.onAgentStart();
		service.onTurnStart();
		now = 300;
		service.onAgentSettled();
		expect(client.events.at(-1)).toEqual({ type: "agent_settled", outcome: "success", durationMs: 180 });
	});

	it("最终文本消息结束时发布回复完成", () => {
		const client = new FakeEventClient();
		const handlers = createOPetEventHandlers(new OPetService({ client, now: () => 0 }));
		const message = assistantMessage();
		handlers.sessionStart(
			{ type: "session_start", reason: "startup" },
			{ sessionManager: { getSessionId: () => "session" } },
		);
		handlers.messageEnd({ type: "message_end", message });
		expect(client.events).toEqual([{ type: "reply_finished" }]);
	});

	it("扩展适配器在工具名出现后立即发布无 ID 活动且不依赖 TUI", () => {
		const client = new FakeEventClient();
		const handlers = createOPetEventHandlers(new OPetService({ client, now: () => 10 }));
		const ctx = { sessionManager: { getSessionId: () => "session-from-pi" } };
		handlers.sessionStart({ type: "session_start", reason: "startup" }, ctx);
		handlers.agentStart({ type: "agent_start" });
		handlers.turnStart({ type: "turn_start", turnIndex: 0, timestamp: 1 });
		const thinkingMessage = assistantMessage();
		handlers.messageUpdate({
			type: "message_update",
			message: thinkingMessage,
			assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: thinkingMessage },
		});
		handlers.messageUpdate({
			type: "message_update",
			message: thinkingMessage,
			assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: thinkingMessage },
		});
		const unnamedMessage = {
			...assistantMessage(),
			content: [{ type: "toolCall" as const, id: "", name: "", arguments: {} }],
		};
		handlers.messageUpdate({
			type: "message_update",
			message: unnamedMessage,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: unnamedMessage },
		});
		const namedMessage = {
			...assistantMessage(),
			content: [{ type: "toolCall" as const, id: "", name: "read", arguments: {} }],
		};
		handlers.messageUpdate({
			type: "message_update",
			message: namedMessage,
			assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "{", partial: namedMessage },
		});
		const completedCall = {
			type: "toolCall" as const, id: "read-1", name: "read", arguments: { path: "/a.ts" },
		};
		const streamedMessage = {
			...assistantMessage(),
			content: [completedCall],
		};
		handlers.messageUpdate({
			type: "message_update",
			message: streamedMessage,
			assistantMessageEvent: {
				type: "toolcall_end", contentIndex: 0, toolCall: completedCall, partial: streamedMessage,
			},
		});
		handlers.toolExecutionStart({
			type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "/a.ts" },
		});
		handlers.toolExecutionUpdate({
			type: "tool_execution_update",
			toolCallId: "read-1",
			toolName: "read",
			args: { path: "/a.ts" },
			partialResult: {},
		});
		handlers.approvalStatus({ type: "requested", toolCallId: "read-1", toolName: "read" });
		handlers.approvalStatus({ type: "resolved", toolCallId: "read-1", outcome: "denied" });
		handlers.toolExecutionEnd({
			type: "tool_execution_end", toolCallId: "read-1", toolName: "read", result: {}, isError: true,
		});
		const failedMessage = { ...assistantMessage(), stopReason: "aborted" as const };
		handlers.messageEnd({ type: "message_end", message: failedMessage });
		handlers.agentSettled({ type: "agent_settled" });
		handlers.sessionShutdown({ type: "session_shutdown", reason: "quit" });

		expect(client.sessions).toEqual(["session-from-pi"]);
		expect(client.events).toEqual([
			{ type: "agent_started" },
			{ type: "turn_started" },
			{ type: "thinking_started" },
			{ type: "reply_started" },
			{ type: "tool_observed", toolName: "read" },
			{ type: "tool_started", toolCallId: "read-1", toolName: "read" },
			{ type: "tool_progressed", toolCallId: "read-1" },
			{ type: "approval_requested", toolCallId: "read-1", toolName: "read" },
			{ type: "approval_resolved", toolCallId: "read-1", outcome: "denied" },
			{ type: "tool_finished", toolCallId: "read-1", outcome: "error" },
			{ type: "agent_settled", outcome: "aborted", durationMs: 0 },
		]);
		expect(client.shutdownCount).toBe(1);
	});

	it("扩展入口只注册状态变化事件", () => {
		const events: string[] = [];
		const channels: string[] = [];
		const pi: ExtensionAPI = new Proxy(Object.create(null), {
			get(_target, property) {
				if (property === "on") return (event: string) => events.push(event);
				if (property === "events") {
					return { on: (channel: string) => { channels.push(channel); return () => {}; } };
				}
				throw new Error(`Unexpected ExtensionAPI property: ${String(property)}`);
			},
		});
		createOPetExtension({ client: new FakeEventClient() })(pi);
		expect(events).toEqual([
			"session_start",
			"agent_start",
			"turn_start",
			"message_update",
			"message_end",
			"tool_execution_start",
			"tool_execution_update",
			"tool_execution_end",
			"agent_settled",
			"session_shutdown",
		]);
		expect(channels).toEqual(["approval-gate:status"]);
	});
});

class FakeEventClient implements OPetEventClient {
	readonly sessions: string[] = [];
	readonly events: OPetEvent[] = [];
	shutdownCount = 0;

	startSession(sessionId: string): void {
		this.sessions.push(sessionId);
	}

	publish(event: OPetEvent): void {
		this.events.push(event);
	}

	shutdown(): void {
		this.shutdownCount += 1;
	}
}

class FakeSocket implements OPetSocket {
	readonly writes: string[] = [];
	destroyed = false;
	acceptWrites = true;
	endedWith: string | undefined;

	constructor(readonly callbacks: OPetSocketCallbacks) {}

	write(data: string): boolean {
		this.writes.push(data);
		return this.acceptWrites;
	}

	end(data: string): void {
		this.endedWith = data;
	}

	destroy(): void {
		this.destroyed = true;
	}

	unref(): void {}
}

function assistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 10,
	};
}

function readJsonLines(socket: Socket, receive: (message: Record<string, unknown>) => void): void {
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			const value: unknown = JSON.parse(line);
			if (typeof value === "object" && value !== null) receive(value as Record<string, unknown>);
		}
	});
}

function listen(server: Server, endpoint: string): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(endpoint, () => {
			server.off("error", reject);
			resolve();
		});
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => error === undefined ? resolve() : reject(error));
	});
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}
