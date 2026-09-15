import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { ContextCache } from "../../src/gui/ui/context-usage.tsx";
import { assistant } from "./transcript-fixtures.ts";

function fields(messages: AgentMessage[]) {
	const { document } = parseHTML(renderToStaticMarkup(createElement(ContextCache, { messages })));
	return Object.fromEntries([...document.querySelectorAll("dl > div")].map((row) => [row.querySelector("dt")?.textContent, row.querySelector("dd")?.textContent]));
}

const message = (input: number, cacheRead: number, cacheWrite: number) => {
	const value = assistant([{ type: "text", text: "完成" }], "stop");
	return { ...value, usage: { ...value.usage, input, cacheRead, cacheWrite, output: 10000, totalTokens: input + cacheRead + cacheWrite + 10000 } };
};

describe("上下文详情中的缓存命中", () => {
	it("最近和累计命中率复用输入及缓存 Token 口径，不计输出 Token", () => {
		expect(fields([message(100, 300, 100), message(100, 900, 0)])).toEqual({
			"最近命中率": "90.0%", "累计命中率": "80.0%", "缓存读取 tokens": "1,200", "缓存写入 tokens": "100",
		});
	});

	it("未产生用量时不把未知命中率显示为零", () => {
		expect(fields([])).toMatchObject({ "最近命中率": "暂无数据", "累计命中率": "暂无数据" });
	});

	it("存在输入但未命中缓存时显示真实零值", () => {
		expect(fields([message(100, 0, 0)])).toMatchObject({ "最近命中率": "0.0%", "累计命中率": "0.0%" });
	});
});
