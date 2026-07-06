import { describe, expect, it } from "vitest";
import { formatCapabilitySummary, summarizeCapabilityGroups } from "../../src/tui/capabilities.js";

const allNames = ["ls", "read", "write", "edit", "find", "grep", "bash", "websearch", "webfetch", "subagent"];

describe("tui capabilities", () => {
	it("all tools enabled 时输出默认能力分组", () => {
		const summaries = summarizeCapabilityGroups({ activeNames: allNames, totalCount: allNames.length, allNames });
		expect(formatCapabilitySummary(summaries, 120)).toBe("files:4 search:2 shell:1 web:2 agent:1");
	});

	it("部分工具 disabled 时输出 active/total", () => {
		const summaries = summarizeCapabilityGroups({ activeNames: allNames.filter((name) => name !== "write"), totalCount: allNames.length, allNames });
		expect(formatCapabilitySummary(summaries, 120)).toContain("files:3/4");
	});

	it("allNames 缺失时根据 activeNames 安全输出", () => {
		const summaries = summarizeCapabilityGroups({ activeNames: ["read", "grep", "bash"], totalCount: 5 });
		expect(formatCapabilitySummary(summaries, 120)).toBe("files:1 search:1 shell:1");
	});

	it("未归组工具显示 other", () => {
		const summaries = summarizeCapabilityGroups({ activeNames: [...allNames, "custom"], totalCount: allNames.length + 1, allNames: [...allNames, "custom"] });
		expect(formatCapabilitySummary(summaries, 120)).toBe("files:4 search:2 shell:1 web:2 agent:1 other:1");
	});

	it("不存在的默认组不显示", () => {
		const summaries = summarizeCapabilityGroups({ activeNames: ["read"], totalCount: 1, allNames: ["read"] });
		expect(formatCapabilitySummary(summaries, 120)).toBe("files:1");
	});

});
