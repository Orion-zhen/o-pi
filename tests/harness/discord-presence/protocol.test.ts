import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { readCoordinatorMessages } from "../../../src/harness/discord-presence/coordinator-protocol.ts";

describe("协调协议消息边界", () => {
	it("支持粘连消息、分片消息和跨分片的 Unicode", () => {
		const socket = new Socket();
		const messages: unknown[] = [];
		const errors: Error[] = [];
		const stop = readCoordinatorMessages(socket, (message) => messages.push(message), (error) => errors.push(error));
		const payload = Buffer.from('{"value":"中文"}\n{"value":"next"}\n');
		socket.emit("data", payload.subarray(0, 12));
		socket.emit("data", payload.subarray(12));
		expect(messages).toEqual([{ value: "中文" }, { value: "next" }]);
		expect(errors).toEqual([]);
		stop();
		socket.destroy();
	});

	it("同一分片的有效消息之后，未终结的超长消息也立即拒绝", () => {
		const socket = new Socket();
		const messages: unknown[] = [];
		const errors: Error[] = [];
		const stop = readCoordinatorMessages(socket, (message) => messages.push(message), (error) => errors.push(error));
		socket.emit("data", Buffer.from(`{}\n${"x".repeat(32 * 1024 + 1)}`));
		expect(messages).toEqual([{}]);
		expect(errors[0]?.message).toContain("size limit");
		stop();
		socket.destroy();
	});

	it("JSON 错误在解码边界报告", () => {
		const socket = new Socket();
		const errors: Error[] = [];
		const stop = readCoordinatorMessages(socket, () => {}, (error) => errors.push(error));
		socket.emit("data", Buffer.from("invalid\n"));
		expect(errors[0]?.message).toContain("not valid JSON");
		expect(errors).toHaveLength(1);
		stop();
		socket.destroy();
	});

	it("协议处理关闭连接后不再消费同一分片的后续消息", () => {
		const socket = new Socket();
		const messages: unknown[] = [];
		const stop = readCoordinatorMessages(socket, (message) => {
			messages.push(message);
			socket.destroy();
		}, () => {});
		socket.emit("data", Buffer.from('{"type":"invalid"}\n{"type":"register"}\n'));
		expect(messages).toEqual([{ type: "invalid" }]);
		stop();
	});
});
