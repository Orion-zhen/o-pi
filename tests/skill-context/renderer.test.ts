import { describe, expect, it } from "vitest";
import { renderSkillCall, renderSkillResult } from "../../src/skill-context/tui/renderer.js";
import type { SkillLoadDetails } from "../../src/skill-context/types.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

describe("skill tool renderer", () => {
	it("完成后清空调用阶段，只保留一张包含关键信息的结果卡", () => {
		const args = { name: "demo" };
		const call = renderSkillCall(args, theme, { isPartial: true });
		expect(call.render(80).join("\n").trim()).not.toBe("");

		renderSkillCall(args, theme, { isPartial: false, lastComponent: call });
		const result = renderSkillResult(details(), { expanded: false, isPartial: false }, theme, { args });
		const output = [call, result].flatMap((component) => component.render(80)).join("\n");

		expect(call.render(80).join("\n").trim()).toBe("");
		expect(output.match(/skill/g)).toHaveLength(1);
		expect(output).toContain("demo");
		expect(output).toContain("project");
	});
});

function details(): SkillLoadDetails {
	return {
		name: "demo",
		root: "skill://demo",
		contentHash: "hash",
		scope: "project",
		loadedBy: "agent",
		deduplicated: false,
		chars: 42,
	};
}
