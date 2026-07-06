import type { ExtensionAPI, MessageRenderer } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { registerSkillStatusRenderer } from "../../src/skill-context/renderer.js";
import { SKILL_CONTEXT_STATUS_MESSAGE, type SkillContextStatusMessage } from "../../src/skill-context/types.js";

describe("skill status renderer", () => {
	it("注册 skill 状态卡片 renderer，样式包含 [skill] 标签和状态", () => {
		let customType: string | undefined;
		let renderer: MessageRenderer<SkillContextStatusMessage> | undefined;

		registerSkillStatusRenderer({
			registerMessageRenderer(type, render) {
				customType = type;
				renderer = render as MessageRenderer<SkillContextStatusMessage>;
			},
		} as Pick<ExtensionAPI, "registerMessageRenderer">);

		expect(customType).toBe(SKILL_CONTEXT_STATUS_MESSAGE);
		const component = renderer?.(
			{
				role: "custom",
				customType: SKILL_CONTEXT_STATUS_MESSAGE,
				content: "skill demo loaded",
				display: true,
				details: { action: "loaded", name: "demo", chars: 4, path: "/skills/demo/SKILL.md" },
				timestamp: 1,
			},
			{ expanded: true },
			{
				fg: (_color: string, text: string) => text,
				bg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			} as never,
		);

		const rendered = component?.render(80).join("\n") ?? "";
		expect(rendered).toContain("[skill]");
		expect(rendered).toContain("demo");
		expect(rendered).toContain("loaded");
		expect(rendered).toContain("/skills/demo/SKILL.md");
	});

	it("hard clear 状态卡片标题显示 hard cleared", () => {
		let renderer: MessageRenderer<SkillContextStatusMessage> | undefined;
		registerSkillStatusRenderer({
			registerMessageRenderer(_type, render) {
				renderer = render as MessageRenderer<SkillContextStatusMessage>;
			},
		} as Pick<ExtensionAPI, "registerMessageRenderer">);

		const component = renderer?.(
			{
				role: "custom",
				customType: SKILL_CONTEXT_STATUS_MESSAGE,
				content: "skill all skills hard cleared",
				display: true,
				details: { action: "cleared", mode: "hard" },
				timestamp: 1,
			},
			{ expanded: false },
			{
				fg: (_color: string, text: string) => text,
				bg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			} as never,
		);

		const rendered = component?.render(80).join("\n") ?? "";
		expect(rendered).toContain("all hard cleared");
	});
});
