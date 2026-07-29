import { describe, expect, it } from "vitest";

import { createVerifiedCodeRegion, type CandidateSignal, type CodeRegion, type TextHit } from "../../src/file-tools/grep/candidates.js";
import { createQueryPlan, type RelationIntent } from "../../src/file-tools/grep/query-plan.js";
import { assignSourceLocalRanks, classifySymbolMatch, rankCodeRegions, selectRankedRegions } from "../../src/file-tools/grep/ranking.js";
import { isFailed } from "../../src/file-tools/shared/result.js";
import { queryPlan, rankingEvidence, semanticRegion, verifiedRegion } from "./grep-ranking-fixtures.js";

describe("grep QueryPlan 与纯排序", () => {
	it.each([
		["login", "identifier"],
		["AuthService.login", "qualified_symbol"],
		["Error: connection reset by peer", "long_text"],
		["where retry delays are calculated", "natural_language"],
	] as const)("将 %s 分类为 %s", (query, shape) => {
		expect(queryPlan(query).shape).toBe(shape);
	});

	it.each([
		["callers of login", "caller", ["login"]],
		["callees of login", "callee", ["login"]],
		["references to login", "reference", ["login"]],
		["tests for AuthService", "test", ["AuthService"]],
		["where UserConfig is imported", "import", ["UserConfig"]],
		["where handler is registered", "registration", ["handler"]],
	] as const)("识别显式关系查询 %s", (query, intent, targets) => {
		const plan = queryPlan(query);
		expect(plan.relationIntents).toEqual([intent satisfies RelationIntent]);
		expect(plan.targetTerms).toEqual(targets);
	});

	it.each([
		[{ query: "   " }, "INVALID_OPERATION"],
		[{ query: "a\0b" }, "INVALID_OPERATION"],
		[{ query: "a\nb", match: "literal" as const }, "INVALID_OPERATION"],
		[{ query: "[", match: "regex" as const }, "INVALID_REGEX"],
		[{ query: "x", path: [] as string[] }, "INVALID_PATH"],
	] as const)("拒绝无效查询参数 %#", (params, code) => {
		const result = createQueryPlan(params);
		expect(isFailed(result) ? result.error.code : undefined).toBe(code);
	});

	it("编译无全局状态的逐行 regex", () => {
		const regex = queryPlan("user_\\d+", "regex").regex;
		expect(regex?.flags).toBe("u");
		expect(regex?.test("user_1")).toBe(true);
		expect(regex?.test("user_2")).toBe(true);
	});

	it("verified 主区域只能由所属范围内的真实 TextHit 构造", () => {
		const region = verifiedRegion({ id: "verified", signals: ["verified_text"], evidence: [rankingEvidence("text-literal")] });
		expect(region.queryMatch).toBe("verified");
		expect(region.matchLines).toEqual([2]);
		const wrongHit: TextHit = { path: "other.ts", line: 2, byteStart: 0, byteEnd: 1, matchStart: 0, matchEnd: 1, mode: "literal", lineText: "x" };
		expect(() => createVerifiedCodeRegion({
			id: "invalid",
			path: "target.ts",
			startLine: 1,
			endLine: 2,
			startByte: 0,
			endByte: 10,
			kind: "text",
			roles: ["text"],
			signals: ["verified_text"],
			evidence: [rankingEvidence("text-literal")],
		}, [wrongHit])).toThrow(RangeError);
	});

	it.each([
		["login", ["exact", "verified", "lsp", "lexical"]],
		["AuthService.login", ["exact-qualified", "member", "lexical"]],
		["Error: connection reset by peer", ["phrase", "enclosing", "lexical"]],
			["where retry delays are calculated", ["phrase", "lexical", "symbol"]],
	] as const)("按查询形态建立硬 tier：%s", (query, expected) => {
		const candidates: CodeRegion[] = query === "login" ? [
			semanticRegion({ id: "lexical", signals: ["lexical"], evidence: [rankingEvidence("ast-lexical")] }),
			semanticRegion({ id: "exact", symbol: "login", signals: ["exact_symbol_definition"], evidence: [rankingEvidence("ast-symbol")] }),
			verifiedRegion({ id: "verified", signals: ["verified_text"], evidence: [rankingEvidence("text-literal")] }),
			semanticRegion({ id: "lsp", signals: ["direct_symbol"], evidence: [rankingEvidence("lsp-symbol")] }),
		] : query === "AuthService.login" ? [
			semanticRegion({ id: "lexical", signals: ["lexical"], evidence: [rankingEvidence("ast-lexical")] }),
			semanticRegion({ id: "member", symbol: "login", qualifiedSymbol: "OtherService.login", signals: ["exact_member_definition"], evidence: [rankingEvidence("ast-symbol")] }),
			semanticRegion({ id: "exact-qualified", symbol: "login", qualifiedSymbol: "AuthService.login", signals: ["exact_qualified_definition"], evidence: [rankingEvidence("ast-symbol")] }),
		] : query.startsWith("Error") ? [
			semanticRegion({ id: "lexical", signals: ["lexical_high_coverage"], evidence: [rankingEvidence("ast-lexical")] }),
			verifiedRegion({ id: "phrase", signals: ["verified_phrase"], evidence: [rankingEvidence("text-literal")] }),
			verifiedRegion({ id: "enclosing", signals: ["verified_enclosing_region"], evidence: [rankingEvidence("text-literal", 2)] }),
		] : [
				semanticRegion({ id: "symbol", signals: ["direct_symbol"], evidence: [rankingEvidence("repo-map-direct")] }),
			semanticRegion({ id: "lexical", signals: ["lexical_high_coverage"], evidence: [rankingEvidence("ast-lexical")] }),
			verifiedRegion({ id: "phrase", signals: ["verified_phrase"], evidence: [rankingEvidence("text-literal")] }),
		];
		expect(rankCodeRegions(queryPlan(query), candidates).map((candidate) => candidate.id)).toEqual(expected);
	});

	it("统一按查询形态判定完整名称、叶子名称和叶子前缀", () => {
		const identifier = queryPlan("grep");
		expect(classifySymbolMatch(identifier, "grep", "grep")).toBe("exact_symbol_definition");
		expect(classifySymbolMatch(identifier, "grep", "FileTools.grep")).toBe("exact_symbol_definition");
		expect(classifySymbolMatch(identifier, "grepAuto", "GrepTool.grepAuto")).toBe("symbol_prefix");
		const qualified = queryPlan("FileTools.grep");
		expect(classifySymbolMatch(qualified, "grep", "FileTools.grep")).toBe("exact_qualified_definition");
		expect(classifySymbolMatch(qualified, "grep", "OtherTools.grep")).toBe("exact_member_definition");
	});

	it("普通 identifier 让生产 prefix 优先于测试中的偶然 exact 声明", () => {
		const production = semanticRegion({
			id: "production",
			path: "packages/file-tools/grep.ts",
			symbol: "grepAuto",
			qualifiedSymbol: "GrepTool.grepAuto",
			roles: ["definition", "public_api"],
			signals: ["symbol_prefix"],
			evidence: [rankingEvidence("ast-symbol", 2)],
		});
		const testDeclaration = semanticRegion({
			id: "test",
			path: "tests/grep.test.ts",
			symbol: "grep",
			roles: ["definition", "test"],
			signals: ["exact_qualified_definition"],
			evidence: [rankingEvidence("ast-symbol"), rankingEvidence("ast-lexical"), rankingEvidence("text-literal")],
		});
		const ranked = rankCodeRegions(queryPlan("grep"), [testDeclaration, production]);
		expect(ranked.map((item) => item.id)).toEqual(["production", "test"]);
		expect(ranked[1]?.matchedBy).toContain("exact-symbol");
		expect(ranked[1]?.matchedBy).not.toContain("exact-qualified-symbol");
		expect(ranked[1]?.ranking.lexical).toBe(0);
	});

	it("显式 test 意图取消测试上下文降权", () => {
		const test = semanticRegion({ id: "test", path: "tests/grep.test.ts", symbol: "grep", roles: ["test"], signals: ["requested_relation"], evidence: [rankingEvidence("ast-relation")] });
		const definition = semanticRegion({ id: "definition", path: "src/grep.ts", symbol: "grep", roles: ["definition"], signals: ["target_definition"], evidence: [rankingEvidence("ast-symbol")] });
		expect(rankCodeRegions(queryPlan("tests for grep"), [definition, test]).map((item) => item.id)).toEqual(["test", "definition"]);
	});

	it("只有显式关系意图允许纯关系候选进入 main", () => {
		const caller = semanticRegion({ id: "caller", signals: ["requested_relation"], evidence: [rankingEvidence("lsp-reference")], roles: ["caller"] });
		const target = semanticRegion({ id: "target", signals: ["target_definition"], evidence: [rankingEvidence("ast-symbol")], roles: ["definition"] });
		expect(rankCodeRegions(queryPlan("login"), [caller, target]).map((item) => item.id)).toEqual([]);
		expect(rankCodeRegions(queryPlan("callers of login"), [target, caller]).map((item) => item.id)).toEqual(["caller", "target"]);
	});

	it("strict 排序排除没有 verified hit 的增强候选", () => {
		const semantic = semanticRegion({ id: "semantic", signals: ["exact_symbol_definition"], evidence: [rankingEvidence("ast-symbol")] });
		const verified = verifiedRegion({ id: "verified", signals: ["verified_text_line"], evidence: [rankingEvidence("text-literal")] });
		expect(rankCodeRegions(queryPlan("needle", "literal"), [semantic, verified]).map((item) => item.id)).toEqual(["verified"]);
	});

	it("strict tier 优先命中符号、普通代码区域和文本行", () => {
		const make = (id: string, signal: CandidateSignal, kind: string, symbol?: string): CodeRegion => {
			const path = `${id}.ts`;
			const hit: TextHit = { path, line: 2, byteStart: 10, byteEnd: 16, matchStart: 0, matchEnd: 6, mode: "literal", lineText: "needle" };
			return createVerifiedCodeRegion({
				id,
				path,
				startLine: 1,
				endLine: 3,
				startByte: 0,
				endByte: 30,
				kind,
				...(symbol === undefined ? {} : { symbol }),
				roles: symbol === undefined ? ["occurrence"] : ["definition"],
				signals: [signal],
				evidence: [rankingEvidence("text-literal")],
			}, [hit]);
		};
		const candidates = [
			make("line", "verified_text_line", "text"),
			make("region", "verified_enclosing_region", "function"),
			make("symbol", "exact_symbol_definition", "function", "needle"),
		];
		expect(rankCodeRegions(queryPlan("needle", "literal"), candidates).map((item) => item.id)).toEqual(["symbol", "region", "line"]);
	});

	it("按来源独立生成稳定名次，不依赖候选插入顺序", () => {
		const values = [
			{ id: "ast-low", source: "ast-symbol" as const, quality: 1 },
			{ id: "text", source: "text-literal" as const, quality: 4 },
			{ id: "ast-high", source: "ast-symbol" as const, quality: 8 },
		];
		const compare = (left: typeof values[number], right: typeof values[number]) => right.quality - left.quality || left.id.localeCompare(right.id);
		const forward = assignSourceLocalRanks(values, (value) => value.source, compare);
		const reverseValues = [...values].reverse();
		const reverse = assignSourceLocalRanks(reverseValues, (value) => value.source, compare);
		expect(Object.fromEntries(values.map((value) => [value.id, forward.get(value)]))).toEqual({ "ast-low": 2, text: 1, "ast-high": 1 });
		expect(Object.fromEntries(reverseValues.map((value) => [value.id, reverse.get(value)]))).toEqual({ "ast-high": 1, text: 1, "ast-low": 2 });
	});

	it("弱来源不能借用不满足事实条件的信号降低 tier", () => {
		const forged = semanticRegion({ id: "forged", signals: ["verified_phrase"], evidence: [rankingEvidence("repo-map-direct")] });
		const direct = semanticRegion({ id: "direct", signals: ["direct_symbol"], evidence: [rankingEvidence("repo-map-direct")] });
		expect(rankCodeRegions(queryPlan("where retry delays are calculated"), [forged, direct]).map((item) => item.id)).toEqual(["direct"]);
	});

	it("稳定 tie-break 依次考虑 verified coverage、请求角色、区域大小和路径", () => {
		const plan = queryPlan("login");
		const compact = semanticRegion({ id: "compact", path: "z.ts", startLine: 1, endLine: 2, signals: ["direct_symbol"], evidence: [rankingEvidence("lsp-symbol")] });
		const large = semanticRegion({ id: "large", path: "a.ts", startLine: 1, endLine: 20, signals: ["direct_symbol"], evidence: [rankingEvidence("lsp-symbol")] });
		expect(rankCodeRegions(plan, [large, compact]).map((item) => item.id)).toEqual(["compact", "large"]);

		const relationPlan = queryPlan("callers of login");
		const requested = semanticRegion({ id: "requested", path: "z.ts", signals: ["requested_relation"], evidence: [rankingEvidence("lsp-reference")], roles: ["caller"] });
		const definition = semanticRegion({ id: "definition", path: "a.ts", signals: ["requested_relation"], evidence: [rankingEvidence("lsp-reference")], roles: ["definition"] });
		expect(rankCodeRegions(relationPlan, [definition, requested]).map((item) => item.id)).toEqual(["requested"]);
	});

	it("selection 保留生产 relevance head，并在尾部覆盖角色和文件", () => {
		const roles: CodeRegion["roles"][] = [
			["definition"], ["definition"], ["definition"], ["definition"],
			["definition", "test"], ["definition", "public_api"], ["definition", "config"],
			...Array.from({ length: 13 }, () => ["definition"] as const),
		];
		const candidates = roles.map((candidateRoles, index) => semanticRegion({
			id: `candidate-${index}`,
			path: index < 4 ? "src/login.ts" : index === 4 ? "tests/login.test.ts" : index === 5 ? "api/login.ts" : index === 6 ? "config/login.ts" : `src/other-${index}.ts`,
			startLine: index + 1,
			endLine: index + 1,
			symbol: "login",
			signals: ["exact_symbol_definition"],
			evidence: [rankingEvidence("ast-symbol", index + 1)],
			roles: candidateRoles,
		}));
		const selected = selectRankedRegions(rankCodeRegions(queryPlan("login"), candidates), 7);
		expect(selected[0]?.id).toBe("candidate-5");
		expect(selected.some((item) => item.roles.includes("test"))).toBe(false);
		expect(new Set(selected.flatMap((item) => item.roles))).toEqual(new Set(["definition", "public_api", "config"]));
		expect(new Set(selected.map((item) => item.path)).size).toBeGreaterThan(3);
	});

	it("关系查询的 MMR 尾部优先覆盖不同文件", () => {
		const candidates = Array.from({ length: 20 }, (_, index) => semanticRegion({
			id: `caller-${index}`,
			path: index < 4 ? "src/auth.ts" : `src/caller-${index}.ts`,
			startLine: index + 1,
			endLine: index + 1,
			signals: ["requested_relation"],
			evidence: [rankingEvidence("ast-relation", index + 1)],
			roles: ["caller"],
		}));
		const selected = selectRankedRegions(rankCodeRegions(queryPlan("callers of login"), candidates), 4);
		expect(selected.slice(0, 3).map((item) => item.id)).toEqual(["caller-0", "caller-1", "caller-2"]);
		expect(selected[3]?.path).not.toBe("src/auth.ts");
	});

	it("融合分数和多样性不能跨越 tier，稳定键不依赖输入顺序", () => {
		const bestA = semanticRegion({ id: "best-a", path: "b.ts", symbol: "login", signals: ["exact_symbol_definition"], evidence: [rankingEvidence("ast-symbol")] });
		const bestB = semanticRegion({ id: "best-b", path: "a.ts", symbol: "login", signals: ["exact_symbol_definition"], evidence: [rankingEvidence("ast-symbol")], roles: ["definition"] });
		const weakTier = semanticRegion({ id: "weak-tier", signals: ["lexical"], evidence: [rankingEvidence("ast-lexical", 1), rankingEvidence("lsp-symbol", 1), rankingEvidence("repo-map-direct", 1)] });
		const forward = rankCodeRegions(queryPlan("login"), [weakTier, bestA, bestB]);
		const reverse = rankCodeRegions(queryPlan("login"), [bestB, bestA, weakTier]);
		expect(forward.map((item) => item.id)).toEqual(["best-b", "best-a", "weak-tier"]);
		expect(reverse.map((item) => item.id)).toEqual(forward.map((item) => item.id));
		expect(selectRankedRegions(forward, 2).map((item) => item.tier)).toEqual([1, 1]);
		expect(selectRankedRegions(reverse, 3).map((item) => item.id)).toEqual(selectRankedRegions(forward, 3).map((item) => item.id));
	});
});
