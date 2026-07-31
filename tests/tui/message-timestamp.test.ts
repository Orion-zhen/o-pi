import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	initTheme,
	SkillInvocationMessageComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { type MarkdownTheme, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import {
	configureMessageTimestampRenderer,
	formatMessageTimestamp,
	recordUserMessageTimestamp,
	resetUserMessageTimestamps,
} from "../../src/tui/message-timestamp.js";

const markdownTheme: MarkdownTheme = {
	heading: identity,
	link: identity,
	linkUrl: identity,
	code: identity,
	codeBlock: identity,
	codeBlockBorder: identity,
	quote: identity,
	quoteBorder: identity,
	hr: identity,
	listBullet: identity,
	bold: identity,
	italic: identity,
	strikethrough: identity,
	underline: identity,
};

const timestamp = new Date(2026, 6, 31, 9, 5, 7).getTime();
const label = "[2026-07-31 09:05:07]";

beforeAll(() => {
	initTheme();
	configureMessageTimestampRenderer({
		dim: identity,
		userBackground: identity,
		customBackground: identity,
	});
});

describe("message timestamp", () => {
	it("按本地时区格式化日期和秒", () => {
		expect(formatMessageTimestamp(timestamp)).toBe(label);
		expect(formatMessageTimestamp(Number.NaN)).toBeUndefined();
	});

	it("用户消息在气泡底部右对齐，并在完整重建时复用原始时间", () => {
		resetUserMessageTimestamps([userMessage("first", timestamp), userMessage("second", timestamp + 1_000)]);
		const first = new UserMessageComponent("first", markdownTheme, 1).render(40);
		new UserMessageComponent("second", markdownTheme, 1).render(40);
		const rebuilt = new UserMessageComponent("first", markdownTheme, 1).render(40);

		assertTimestamp(first, 40);
		assertTimestamp(rebuilt, 40);
	});

	it("实时用户消息使用事件携带的时间", () => {
		resetUserMessageTimestamps([]);
		recordUserMessageTimestamp(userMessage("live", timestamp));
		const lines = new UserMessageComponent("live", markdownTheme, 2).render(40);

		assertTimestamp(lines, 40);
	});

	it("纯 skill 用户消息也显示时间戳", () => {
		resetUserMessageTimestamps([userMessage("<skill name=\"review\" location=\"/skill/SKILL.md\">\ncontent\n</skill>", timestamp)]);
		const component = new SkillInvocationMessageComponent({
			name: "review",
			location: "/skill/SKILL.md",
			content: "content",
			userMessage: undefined,
		}, markdownTheme);

		assertTimestamp(component.render(40), 40);
	});

	it.each([21, 40])("正文出现后立即显示时间，宽度为 %i 时不溢出", (width) => {
		const message = assistantMessage([{ type: "text", text: "answer" }], timestamp);
		const lines = new AssistantMessageComponent(message, false, markdownTheme, "Thinking...", 1).render(width);

		assertTimestamp(lines, width);
	});

	it("思考内容完成后也不显示时间戳", () => {
		const message = assistantMessage([{ type: "thinking", thinking: "reasoning" }], timestamp);
		const lines = new AssistantMessageComponent(message, false, markdownTheme, "Thinking...", 1).render(40);

		expect(lines.join("\n")).not.toContain(label);
	});

	it("流式思考阶段隐藏时间戳，正文开始后立即显示", () => {
		const thinking = assistantMessage([{ type: "thinking", thinking: "reasoning" }], timestamp);
		const component = new AssistantMessageComponent(thinking, false, markdownTheme, "Thinking...", 1);

		expect(component.render(40).join("\n")).not.toContain(label);
		component.updateContent(assistantMessage([
			{ type: "thinking", thinking: "reasoning" },
			{ type: "text", text: "answer" },
		], timestamp));
		assertTimestamp(component.render(40), 40);
	});
});

function userMessage(content: string, messageTimestamp: number): UserMessage {
	return { role: "user", content, timestamp: messageTimestamp };
}

function assistantMessage(content: AssistantMessage["content"], messageTimestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: messageTimestamp,
	};
}

function identity(text: string): string {
	return text;
}

function assertTimestamp(lines: string[], width: number): void {
	expect(lines.join("\n")).toContain(label);
	expect(lines.filter((line) => line.includes(label))).toHaveLength(1);
	expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
}
