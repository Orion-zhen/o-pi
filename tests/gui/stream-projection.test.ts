import { expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { GuiEvent } from "../../src/gui/shared/protocol/events.ts";
import type { GuiSnapshot } from "../../src/gui/shared/protocol/state.ts";
import { GuiChannel } from "../../src/gui/host/channel.ts";
import { GuiPayloads } from "../../src/gui/host/projection/payloads.ts";
import { GuiStream } from "../../src/gui/host/projection/stream.ts";
import { GuiReceiver, type GuiDelivery, type GuiFrame } from "../../src/gui/shared/protocol/sync.ts";
import { assistant, call } from "./transcript-fixtures.ts";
import { guiSnapshot } from "./snapshot-fixture.ts";

function projected(stream: GuiStream): AssistantMessage {
	const value = stream.project();
	if (value?.role !== "assistant") throw new Error("缺少模型消息");
	return value;
}

function peer() {
	const receiver = new GuiReceiver();
	const frames: GuiFrame[] = [];
	let snapshot: GuiSnapshot | null = null;
	const channel = new GuiChannel((delivery) => {
		const wire = JSON.parse(JSON.stringify(delivery)) as GuiDelivery;
		if (wire.kind !== "frame") throw new Error("不应收到通知");
		frames.push(wire);
		for (const event of wire.events) {
			const received = receiver.accept(event);
			if (received.type === "snapshot") snapshot = received.value;
		}
	});
	return { channel, frames, snapshot: () => snapshot, push: async (event: GuiEvent) => { channel.accept(event); await Promise.resolve(); } };
}

it("共享 partial 提前变化也只消费已到达的正文 delta，结束事件校准全文", () => {
	const stream = new GuiStream(new GuiPayloads());
	const partial = assistant([{ type: "text", text: "已提前生成的全文" }], "pending");
	stream.start(partial);
	expect(projected(stream).content).toEqual([]);
	stream.update({ type: "text_start", contentIndex: 0, partial });
	expect(projected(stream).content).toEqual([{ type: "text", text: "" }]);
	expect(stream.update({ type: "text_delta", contentIndex: 0, delta: "你", partial })).toBe(true);
	const first = projected(stream);
	partial.content[0] = { type: "text", text: "另一个权威结果", textSignature: "final" };
	partial.usage.output = 99;
	expect(stream.project()).toBe(first);
	stream.update({ type: "text_delta", contentIndex: 0, delta: "好", partial });
	expect(projected(stream).content).toEqual([{ type: "text", text: "你好" }]);
	expect(first.content).toEqual([{ type: "text", text: "你" }]);
	expect(first.usage.output).toBe(1);
	expect(stream.update({ type: "text_end", contentIndex: 0, content: "最终正文", partial })).toBe(false);
	expect(projected(stream).content).toEqual([{ type: "text", text: "最终正文", textSignature: "final" }]);
	expect(projected(stream).usage.output).toBe(99);
});

it("正文后生成工具参数，旧快照保持不变", () => {
	const stream = new GuiStream(new GuiPayloads());
	const partial = assistant([{ type: "text", text: "先检查文件" }], "pending");
	stream.start(partial);
	stream.update({ type: "text_start", contentIndex: 0, partial });
	stream.update({ type: "text_end", contentIndex: 0, content: "先检查文件", partial });
	const args: Record<string, string> = {};
	partial.content.push({ ...call, arguments: args });
	stream.update({ type: "toolcall_start", contentIndex: 1, partial });
	const initial = projected(stream);
	args.path = "a.ts";
	stream.update({ type: "toolcall_delta", contentIndex: 1, delta: '{"path":"a.ts"}', partial });
	stream.update({ type: "toolcall_end", contentIndex: 1, toolCall: { ...call, arguments: args }, partial });
	expect(projected(stream).content).toEqual([{ type: "text", text: "先检查文件" }, { ...call, arguments: { path: "a.ts" } }]);
	expect(initial.content).toEqual([{ type: "text", text: "先检查文件" }, { ...call, arguments: {} }]);
});

it("后台只累计当前块，恢复读取时得到完整正文，结束与新消息不复用旧内容", () => {
	const stream = new GuiStream(new GuiPayloads());
	const partial = assistant([{ type: "thinking", thinking: "未来的思考" }], "pending");
	stream.start(partial);
	stream.update({ type: "thinking_start", contentIndex: 0, partial });
	for (const delta of ["先", "检查", "文件"]) stream.update({ type: "thinking_delta", contentIndex: 0, delta, partial });
	expect(projected(stream).content).toEqual([{ type: "thinking", thinking: "先检查文件" }]);
	stream.update({ type: "thinking_end", contentIndex: 0, content: "先检查文件", partial });
	partial.content.push({ type: "text", text: "检查完成" });
	stream.update({ type: "text_start", contentIndex: 1, partial });
	stream.update({ type: "text_delta", contentIndex: 1, delta: "检查完成", partial });
	expect(projected(stream).content).toEqual([{ type: "thinking", thinking: "先检查文件" }, { type: "text", text: "检查完成" }]);
	stream.end();
	expect(stream.project()).toBeNull();
	const redacted = assistant([{ type: "thinking", thinking: "redacted", redacted: true }], "pending");
	stream.start(redacted);
	stream.update({ type: "thinking_start", contentIndex: 0, partial: redacted });
	expect(projected(stream).content).toEqual(redacted.content);
	stream.start({ role: "user", content: "下一轮", timestamp: 200 });
	expect(stream.project()).toEqual({ role: "user", content: "下一轮", timestamp: 200 });
});

it("发送窗口满时合并追加，确认后以最后发送状态生成补丁，重连从完整基线继续", async () => {
	const stream = new GuiStream(new GuiPayloads());
	const partial = assistant([{ type: "text", text: "提前生成的其他正文" }], "pending");
	stream.start(partial);
	stream.update({ type: "text_start", contentIndex: 0, partial });
	const initial = { ...guiSnapshot(), streamingMessage: stream.project() };
	const client = peer(), reconnect = peer();
	try {
		await client.push({ type: "snapshot", value: initial });
		for (let index = 0; index < 12; index++) {
			const appendOnly = stream.update({ type: "text_delta", contentIndex: 0, delta: "x", partial });
			await client.push({ type: "stream", sessionId: initial.sessionId, value: stream.project(), appendOnly });
		}
		expect(client.frames).toHaveLength(4);
		client.channel.acknowledge(4);
		await Promise.resolve();
		expect(client.frames).toHaveLength(5);
		expect(client.snapshot()?.streamingMessage).toEqual(stream.project());
		expect(client.frames.at(-1)?.events).toMatchObject([{ type: "patch", streamingMessage: { kind: "content", blocks: [{ index: 0, field: "text", delta: "x".repeat(9) }] } }]);
		await reconnect.push({ type: "snapshot", value: { ...initial, streamingMessage: stream.project() } });
		const appendOnly = stream.update({ type: "text_delta", contentIndex: 0, delta: "尾部", partial });
		const event: GuiEvent = { type: "stream", sessionId: initial.sessionId, value: stream.project(), appendOnly };
		await Promise.all([client.push(event), reconnect.push(event)]);
		expect(client.snapshot()?.streamingMessage).toEqual(reconnect.snapshot()?.streamingMessage);
		stream.end();
		await client.push({ type: "snapshot", value: { ...initial, streamingMessage: stream.project() } });
		expect(client.snapshot()?.streamingMessage).toBeNull();
	} finally { client.channel.close(); reconnect.channel.close(); }
});

it.each(["snapshot", "stream"] as const)("同批 %s 校准和后续追加不会被误判为相对旧基线的纯追加", async (type) => {
	const client = peer();
	const initial = { ...guiSnapshot(), streamingMessage: assistant([{ type: "text", text: "旧正文" }], "pending") };
	try {
		await client.push({ type: "snapshot", value: initial });
		const calibrated = assistant([{ type: "text", text: "新" }], "pending");
		client.channel.accept(type === "snapshot" ? { type, value: { ...initial, streamingMessage: calibrated } }
			: { type, sessionId: initial.sessionId, value: calibrated, appendOnly: false });
		await client.push({ type: "stream", sessionId: initial.sessionId, value: assistant([{ type: "text", text: "新正文" }], "pending"), appendOnly: true });
		expect(client.snapshot()?.streamingMessage).toEqual(assistant([{ type: "text", text: "新正文" }], "pending"));
	} finally { client.channel.close(); }
});
