import { describe, expect, it } from "vitest";

import { createQueryPlan } from "../../src/file-tools/grep/query-plan.js";
import { classifySymbolMatch, rankCodeRegions } from "../../src/file-tools/grep/ranking.js";
import { isFailed } from "../../src/file-tools/shared/result.js";
import { queryPlan, rankingEvidence, semanticRegion, verifiedRegion } from "./grep-ranking-fixtures.js";

describe("grep query plan", () => {
	it("建立统一逐行正则、机械词项和无操作符结构查询", () => {
		const plan = queryPlan("Auth(Service|Client)");
		expect(plan.queryMode).toBe("regex");
		expect(plan.regex.test("const x = new AuthService()")).toBe(true);
		expect(plan.targetTerms).toEqual(["Auth", "Service", "Client"]);
		expect(plan.targetQuery).toBe("Auth Service Client");
		expect(plan.structuredQuery).toBeUndefined();
		expect(queryPlan("src/file-tools/find").structuredQuery).toBe("src/file-tools/find");
	});

	it.each([
		[{ query: "" }, "INVALID_OPERATION"],
		[{ query: "a\nb" }, "INVALID_OPERATION"],
	] as const)("拒绝非法 query：%j", (params, code) => {
		const result = createQueryPlan(params);
		expect(isFailed(result) ? result.error.code : undefined).toBe(code);
	});

	it("非法正则建立 exact literal probe，并保留原始失败", () => {
		const plan = queryPlan("read(input");
		expect(plan).toMatchObject({
			queryMode: "literal_fallback",
			invalidRegex: {
				status: "failed",
				error: {
					code: "INVALID_REGEX",
					next: expect.stringContaining("opening parenthesis"),
				},
			},
		});
		expect(plan.regex.test("read(input)")).toBe(true);
		expect(plan.regex.test("readinput")).toBe(false);
	});

	it("按 regex 失败类型生成不同恢复动作", () => {
		const cases = [
			["(", "opening parenthesis"],
			["foo)", "closing parenthesis"],
			["[", "character class"],
			["\\", "trailing backslash"],
			["[z-a]", "range endpoints"],
			["*foo", "quantifier"],
			["a{2,1}", "minimum"],
			["(?", "group form"],
			["(?<a>x)(?<a>y)", "unique name"],
			["(?<1>x)", "valid identifier"],
			["\\k<missing>", "backreference name"],
			["\\u{}", "Unicode escape"],
			["\\p{Nope}", "Unicode property"],
		] as const;
		const hints = cases.map(([query, expected]) => {
			const plan = queryPlan(query);
			if (plan.queryMode !== "literal_fallback") throw new Error(`expected invalid regex: ${query}`);
			expect(plan.invalidRegex.error.next).toContain(expected);
			return plan.invalidRegex.error.next;
		});
		expect(new Set(hints)).toHaveLength(cases.length);
	});
});

describe("grep ranking", () => {
	it("根据 query 与 live AST 名称统一判定 symbol tier", () => {
		const identifier = queryPlan("grep");
		expect(classifySymbolMatch(identifier, "grep", "FileTools.grep")).toBe("exact_symbol_definition");
		expect(classifySymbolMatch(identifier, "grepAuto", "GrepTool.grepAuto")).toBe("symbol_prefix");
		const qualified = queryPlan("FileTools.grep");
		expect(classifySymbolMatch(qualified, "grep", "FileTools.grep")).toBe("exact_qualified_definition");
	});

	it("不读取路径语义，优先返回具有 incoming call authority 的定义", () => {
		const testDefinition = semanticRegion({
			id: "test",
			path: "tests/grep.test.ts",
			symbol: "grep",
			signals: ["lexical"],
			authority: "defined",
			evidence: rankingEvidence("text-lexical"),
		});
		const productionDefinition = semanticRegion({
			id: "production",
			path: "src/grep.ts",
			symbol: "grep",
			signals: ["lexical"],
			authority: "called",
			evidence: rankingEvidence("text-lexical"),
		});
		expect(rankCodeRegions(queryPlan("grep"), [testDefinition, productionDefinition]).map((item) => item.id))
			.toEqual(["production", "test"]);
	});

	it("同 authority 只使用候选自身字段形成稳定顺序", () => {
		const left = semanticRegion({
			id: "left",
			path: "z-production.ts",
			signals: ["lexical"],
			evidence: rankingEvidence("text-lexical"),
		});
		const test = semanticRegion({
			id: "test",
			path: "a-tests/feature.test.ts",
			signals: ["lexical"],
			evidence: rankingEvidence("text-lexical"),
		});
		const forward = rankCodeRegions(queryPlan("missing"), [left, test]).map((item) => item.id);
		const reverse = rankCodeRegions(queryPlan("missing"), [test, left]).map((item) => item.id);
		expect(forward).toEqual(["test", "left"]);
		expect(reverse).toEqual(forward);
	});

	it("正文命中 tier 高于 related 候选", () => {
		const direct = verifiedRegion({
			id: "direct",
			signals: ["verified_enclosing_region"],
			evidence: rankingEvidence("text-regex"),
		});
		const related = semanticRegion({
			id: "related",
			signals: ["lexical_high_coverage"],
			evidence: rankingEvidence("text-lexical"),
		});
		expect(rankCodeRegions(queryPlan("needle"), [related, direct]).map((item) => item.id))
			.toEqual(["direct", "related"]);
	});
});
