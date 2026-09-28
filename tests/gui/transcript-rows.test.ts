import { act, createElement, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SKILL_CONTEXT_MESSAGE } from "../../src/harness/skill-context/types.ts";
import { useTranscriptRows } from "../../src/gui/ui/use-transcript-rows.ts";
import type { TranscriptSource } from "../../src/gui/ui/transcript-items.ts";
import type { TranscriptRow } from "../../src/gui/ui/transcript-replies.ts";
import { assistant, call, result, source } from "./transcript-fixtures.ts";

const user = { role: "user", content: "检查文件", timestamp: 1 } as const;
const skill = { role: "custom", customType: SKILL_CONTEXT_MESSAGE, content: "技能正文", display: true, timestamp: 2 } as const;
const pruned = new Set<string>();
let root: ReturnType<typeof createRoot>;
let rows: TranscriptRow[];

function Projection({ source }: { source: TranscriptSource }) {
	const value = useTranscriptRows(source, pruned);
	useLayoutEffect(() => { rows = value; }, [value]);
	return null;
}
const render = async (source: TranscriptSource) => {
	await act(async () => root.render(createElement(Projection, { source })));
};
const tools = () => rows.flatMap((row) => row.kind === "reply" ? row.process.filter((item) => item.kind === "tool") : []);

beforeEach(() => {
	const { window, document } = parseHTML("<html><body></body></html>");
	vi.stubGlobal("window", window);
	vi.stubGlobal("document", document);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	root = createRoot(document.body);
	rows = [];
});
afterEach(async () => {
	await act(async () => root.unmount());
	vi.unstubAllGlobals();
});

describe("流式历史分组", () => {
	it("已中止且没有结果的历史调用不随下一轮流式正文重新投影", async () => {
		const initial = source({ messages: [user, assistant([call], "aborted"), { ...user, content: "下一轮", timestamp: 3 }], streaming: true });
		await render(initial);
		const history = rows[1];
		expect(history).toMatchObject({ kind: "reply", state: "stopped", process: [{ tool: { id: call.id, state: "stopped" } }] });
		for (const text of ["继续", "继续检查"]) {
			await render({ ...initial, streamingMessage: assistant([{ type: "text", text }], "stop") });
			expect(rows[1]).toBe(history);
		}
	});

	it("技能消息之后仍关联之前的在途调用，进度更新不产生重复工具", async () => {
		const initial = source({ messages: [user, assistant([call]), skill], streaming: true });
		await render(initial);
		for (const text of ["读取中", "正在完成"]) {
			await render({ ...initial, liveTools: [{ toolCallId: call.id, toolName: call.name, args: call.arguments,
				output: { kind: "inline", value: { content: [{ type: "text", text }] } } }] });
			expect(tools()).toHaveLength(1);
			expect(tools()[0]).toMatchObject({ tool: { id: call.id, state: "running", output: { value: { content: [{ text }] } } } });
		}
		await render(source({ messages: [user, assistant([call]), skill, result, assistant([{ type: "text", text: "完成" }], "stop")] }));
		expect(tools()).toHaveLength(1);
		expect(tools()[0]).toMatchObject({ tool: { id: call.id, state: "completed" } });
	});
});
