import { act, createElement, useLayoutEffect } from "react";
import { useReactFixture } from "../../../../helpers/react-fixture.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GuiPayloads } from "../../../../../../src/gui/host/projection/payloads.ts";
import { GuiHistory } from "../../../../../../src/gui/host/projection/history.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { GuiToolOutput, ToolOutput } from "../../../../../../src/gui/shared/messages/types.ts";
import type { Query } from "../../../../../../src/gui/shared/protocol/queries.ts";
import { ContentVisible } from "../../../../../../src/gui/frontend/ui/collapsible.tsx";
import { GuiQueryContext } from "../../../../../../src/gui/frontend/connection/query-context.ts";
import { useToolOutput } from "../../../../../../src/gui/frontend/features/chat/tools/use-tool-output.ts";
import { deferred } from "../../../../../helpers/async.ts";

const renderRoot = useReactFixture();
let query = vi.fn<Query>();
let payloads: GuiPayloads;
let state: ReturnType<typeof useToolOutput>;
const large = (text: string): ToolOutput => ({ content: [{ type: "text", text: text.repeat(70_000) }] });
function reference(output: GuiToolOutput): string {
	if (output.kind !== "reference") throw new Error("缺少大载荷引用");
	return output.id;
}
function Output({ id }: { id: string | undefined }) {
	const value = useToolOutput(id);
	useLayoutEffect(() => { state = value; }, [value]);
	return null;
}
async function render(id: string | undefined, visible = true) {
	await renderRoot(createElement(GuiQueryContext, { value: query as Query },
		createElement(ContentVisible, { value: visible }, createElement(Output, { id }))));
}

beforeEach(() => {
	query = vi.fn<Query>();
	payloads = new GuiPayloads();
	state = { value: undefined, error: "" };
});

describe("大工具结果按需查询", () => {
	it("读取同一调用的新进度时保留正文，不退回加载占位符", async () => {
		const first = reference(payloads.progress("call", "extension", large("a")));
		query.mockResolvedValueOnce(payloads.toolOutput(first));
		await render(first);
		expect(state.value).toEqual(large("a"));
		const next = reference(payloads.progress("call", "extension", large("b")));
		const pending = deferred<ToolOutput>();
		query.mockReturnValueOnce(pending.promise);
		await render(next);
		expect(query).toHaveBeenLastCalledWith({ query: "toolOutput", id: next });
		expect(state.value).toEqual(large("a"));
		await act(async () => pending.resolve(payloads.toolOutput(next)));
		expect(state.value).toEqual(large("b"));
	});

	it("已展开的完成结果进入历史时不重新读取或清空正文", async () => {
		const content = [{ type: "text" as const, text: "x".repeat(70_000) }];
		const live = reference(payloads.retainResult("call", "extension", { content }));
		query.mockResolvedValueOnce(payloads.toolOutput(live));
		await render(live);
		const loaded = state.value;
		expect(loaded).toEqual({ content });
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "toolResult", toolCallId: "call", toolName: "extension", content, isError: false, timestamp: 1 });
		const history = new GuiHistory(payloads).project(manager);
		const message = history.entries.flatMap((entry) => entry.messages).find((item) => item.role === "toolResult");
		if (!message) throw new Error("缺少历史结果");
		await render(reference(message.output));
		expect(query).toHaveBeenCalledOnce();
		expect(state.value).toBe(loaded);
	});

	it("折叠后停止读取，展开时补齐最新进度，最终内联结果不沿用旧载荷", async () => {
		const first = reference(payloads.progress("call", "extension", large("a")));
		await render(first, false);
		expect(query).not.toHaveBeenCalled();
		query.mockResolvedValueOnce(payloads.toolOutput(first));
		await render(first);
		await render(first, false);
		const next = reference(payloads.progress("call", "extension", large("b")));
		await render(next, false);
		expect(query).toHaveBeenCalledTimes(1);
		expect(state.value).toEqual(large("a"));
		query.mockResolvedValueOnce(payloads.toolOutput(next));
		await render(next);
		expect(state.value).toEqual(large("b"));
		expect(payloads.complete("call", "extension", { content: [] }).kind).toBe("inline");
		await render(undefined, false);
		expect(state.value).toBeUndefined();
	});

	it("迟到的旧请求不能覆盖已显示的新进度", async () => {
		const first = reference(payloads.progress("call", "extension", large("a")));
		const old = payloads.toolOutput(first);
		const pending = deferred<ToolOutput>();
		query.mockReturnValueOnce(pending.promise);
		await render(first);
		const next = reference(payloads.progress("call", "extension", large("b")));
		query.mockResolvedValueOnce(payloads.toolOutput(next));
		await render(next);
		await act(async () => pending.resolve(old));
		expect(state.value).toEqual(large("b"));
	});

	it("切换到不同载荷时不把上一份正文当作新结果", async () => {
		const first = reference(payloads.output("extension", large("a")));
		query.mockResolvedValueOnce(payloads.toolOutput(first));
		await render(first);
		const next = reference(payloads.output("extension", large("b")));
		const pending = deferred<ToolOutput>();
		query.mockReturnValueOnce(pending.promise);
		await render(next);
		expect(state.value).toBeUndefined();
		await act(async () => pending.resolve(payloads.toolOutput(next)));
		expect(state.value).toEqual(large("b"));
	});
});
