import { describe, expect, it } from "vitest";
import { parseSkillFile } from "../../src/skill-context/frontmatter.js";

describe("skill frontmatter", () => {
	it("解析 name、description 和去 frontmatter 后的 body", () => {
		const parsed = parseSkillFile("---\nname: demo\ndescription: 用于测试\n---\n\nbody\n", "fallback", 100);
		expect(parsed).toEqual({ name: "demo", description: "用于测试", body: "body" });
	});

	it("支持 CRLF", () => {
		const parsed = parseSkillFile("---\r\nname: demo\r\ndescription: desc\r\n---\r\nbody\r\nnext\r\n", "fallback", 100);
		expect(parsed.body).toBe("body\nnext");
	});

	it("缺少 description 时报错", () => {
		expect(() => parseSkillFile("---\nname: demo\n---\nbody\n", "fallback", 100)).toThrow(/description/);
	});

	it("拒绝非法 name", () => {
		expect(() => parseSkillFile("---\nname: Bad--Name\ndescription: desc\n---\nbody\n", "fallback", 100)).toThrow(/name/);
	});

	it("body 超过 max_body_chars 时提示配置或拆分 reference", () => {
		expect(() => parseSkillFile("---\nname: demo\ndescription: desc\n---\n12345", "fallback", 4)).toThrow(/max_body_chars|references/);
	});
});

