import { describe, expect, it } from "vitest";

import { createQueryPlan } from "../../src/file-tools/grep/query-plan.js";
import { assignSourceLocalRanks, classifySymbolMatch, rankCodeRegions } from "../../src/file-tools/grep/ranking.js";
import { isFailed } from "../../src/file-tools/shared/result.js";
import { queryPlan, rankingEvidence, semanticRegion, verifiedRegion } from "./grep-ranking-fixtures.js";

describe("grep query plan", () => {
	it("建立统一逐行正则、机械词项和无操作符结构查询", () => {
		const plan = queryPlan("Auth(Service|Client)");
		expect(plan.regex.test("const x = new AuthService()")).toBe(true);
		expect(plan.targetTerms).toEqual(["Auth", "Service", "Client"]);
		expect(plan.targetQuery).toBe("Auth Service Client");
		expect(plan.structuredQuery).toBeUndefined();
		expect(queryPlan("src/file-tools/find").structuredQuery).toBe("src/file-tools/find");
	});

	it.each([
		[{ query: "" }, "INVALID_OPERATION"],
		[{ query: "a\nb" }, "INVALID_OPERATION"],
		[{ query: "[" }, "INVALID_REGEX"],
	] as const)("拒绝非法 query：%j", (params, code) => {
		const result = createQueryPlan(params);
		expect(isFailed(result) ? result.error.code : undefined).toBe(code);
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

	it("不识别 tests/src 负向上下文，测试中的强证据可以压过生产代码", () => {
		const testDefinition = semanticRegion({
			id: "test",
			path: "tests/grep.test.ts",
			symbol: "grep",
			roles: ["definition", "test"],
			signals: ["lexical"],
			evidence: [rankingEvidence("lsp-symbol")],
		});
		const productionBody = verifiedRegion({
			id: "production",
			signals: ["verified_enclosing_region"],
			evidence: [rankingEvidence("text-regex")],
		});
		expect(rankCodeRegions(queryPlan("grep"), [productionBody, testDefinition]).map((item) => item.id))
			.toEqual(["test", "production"]);
	});

	it("同证据只使用候选自身字段形成稳定顺序", () => {
		const left = semanticRegion({
			id: "left",
			path: "z-production.ts",
			signals: ["lexical"],
			evidence: [rankingEvidence("text-lexical")],
		});
		const test = semanticRegion({
			id: "test",
			path: "a-tests/feature.test.ts",
			roles: ["definition", "test"],
			signals: ["lexical"],
			evidence: [rankingEvidence("text-lexical")],
		});
		const forward = rankCodeRegions(queryPlan("missing"), [left, test]).map((item) => item.id);
		const reverse = rankCodeRegions(queryPlan("missing"), [test, left]).map((item) => item.id);
		expect(forward).toEqual(["test", "left"]);
		expect(reverse).toEqual(forward);
	});

	it("正文命中 tier 高于 related 候选", () => {
		const direct = verifiedRegion({
			id: "direct",
			signals: ["verified_text"],
			evidence: [rankingEvidence("text-regex")],
		});
		const related = semanticRegion({
			id: "related",
			signals: ["lexical_high_coverage"],
			evidence: [rankingEvidence("text-lexical")],
		});
		expect(rankCodeRegions(queryPlan("needle"), [related, direct]).map((item) => item.id))
			.toEqual(["direct", "related"]);
	});

	it("按来源独立生成稳定名次，不依赖候选插入顺序", () => {
		const values = [
			{ id: "lexical-low", source: "text-lexical" as const, quality: 1 },
			{ id: "text", source: "text-regex" as const, quality: 4 },
			{ id: "lexical-high-tie", source: "text-lexical" as const, quality: 8 },
			{ id: "lexical-high", source: "text-lexical" as const, quality: 8 },
		];
		const relevance = (left: typeof values[number], right: typeof values[number]) =>
			right.quality - left.quality;
		const stable = (left: typeof values[number], right: typeof values[number]) =>
			left.id.localeCompare(right.id);
		const forward = assignSourceLocalRanks(values, (item) => item.source, relevance, stable);
		const reverseValues = [...values].reverse();
		const reverse = assignSourceLocalRanks(reverseValues, (item) => item.source, relevance, stable);
		expect(values.map((item) => forward.get(item))).toEqual([2, 1, 1, 1]);
		expect(values.map((item) => reverse.get(item))).toEqual([2, 1, 1, 1]);
	});
});
