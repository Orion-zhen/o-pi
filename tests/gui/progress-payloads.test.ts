import { describe, expect, it } from "vitest";
import { GuiPayloads } from "../../src/gui/host/payloads.ts";
import type { GuiToolOutput } from "../../src/gui/messages.ts";

function reference(output: GuiToolOutput): string {
	if (output.kind !== "reference") throw new Error("缺少载荷引用");
	return output.id;
}
const large = (text: string) => ({ content: [{ type: "text", text: text.repeat(70_000) }] });

describe("工具进度载荷", () => {
	it("旧引用读取最新进度，完成后的历史结果不受其他调用影响", () => {
		const payloads = new GuiPayloads();
		const first = reference(payloads.progress("call", "subagent", large("a")));
		const next = reference(payloads.progress("call", "subagent", large("b")));
		expect(next).not.toBe(first);
		expect(payloads.toolOutput(first)).toEqual(large("b"));
		expect(payloads.toolOutput(next)).toBe(payloads.toolOutput(first));
		const final = reference(payloads.complete("call", "subagent", large("c")));
		expect(payloads.toolOutput(first)).toEqual(large("c"));
		payloads.progress("other", "subagent", large("d"));
		expect(payloads.toolOutput(final)).toEqual(large("c"));
	});

	it("大结果变为内联结果时，在途查询仍可完成", () => {
		const payloads = new GuiPayloads();
		const id = reference(payloads.progress("call", "bash", large("log")));
		const content = [{ type: "text" as const, text: "已完成" }];
		const final = payloads.message({ role: "toolResult", toolCallId: "call", toolName: "bash", content, isError: false, timestamp: 1 });
		expect(final).toMatchObject({ output: { kind: "inline", value: { content } } });
		expect(payloads.toolOutput(id)).toEqual({ content });
	});

	it("更新图片复用载荷位置，旧图片请求和最终回看均可读取", () => {
		const payloads = new GuiPayloads();
		const image = (data: string) => ({ type: "image", mimeType: "image/png", data });
		const first = reference(payloads.progress("call", "extension", { ...large("a"), content: [...large("a").content, image("Zmlyc3Q=")] }));
		const content = payloads.toolOutput(first).content;
		if (!Array.isArray(content)) throw new Error("缺少工具正文");
		const previous: unknown = content[1];
		if (typeof previous !== "object" || previous === null || !("imageId" in previous) || typeof previous.imageId !== "string") throw new Error("缺少图片引用");
		const next = reference(payloads.progress("call", "extension", { content: [...large("b").content, image("bmV4dA==")] }));
		expect(payloads.image(previous.imageId)).toBe("bmV4dA==");
		expect(payloads.toolOutput(first)).toBe(payloads.toolOutput(next));
		const result = payloads.complete("call", "extension", { content: [image("ZmluYWw=")] });
		expect(result).toMatchObject({ kind: "inline", value: { content: [{ imageId: expect.any(String) }] } });
		expect(payloads.image(previous.imageId)).toBe("ZmluYWw=");
	});
});
