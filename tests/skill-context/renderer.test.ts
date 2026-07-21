import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { registerSkillMessageRenderer } from "../../src/skill-context/renderer.js";
import { SKILL_CONTEXT_MESSAGE, type SkillLoadDetails } from "../../src/skill-context/types.js";

describe("技能消息渲染器", () => {
	it("展示逻辑技能标识且不包含宿主路径", () => {
		let renderer: MessageRenderer<SkillLoadDetails> | undefined;
		registerSkillMessageRenderer({ registerMessageRenderer(_type, value) { renderer = value as MessageRenderer<SkillLoadDetails>; } });
		const component = renderer?.({
			role: "custom", customType: SKILL_CONTEXT_MESSAGE, content: "body", display: true, timestamp: 1,
			details: { name: "demo", root: "skill://demo", contentHash: "hash", scope: "project", loadedBy: "manual", deduplicated: false, chars: 4 },
		}, { expanded: true }, {
			fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text,
		} as never);
		const output = component?.render(80).join("\n") ?? "";
		expect(output).toContain("[skill]");
		expect(output).toContain("demo loaded");
		expect(output).toContain("project · manual · 4 chars");
		expect(output).not.toContain("/skills/");
	});
});
