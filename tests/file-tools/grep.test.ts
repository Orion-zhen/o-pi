import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseCodeUnits, type IndexedCodeUnit } from "../../src/code-index/parser.js";
import { clearGrepIndex } from "../../src/file-tools/grep/indexer.js";
import { mergeRankedGrepSources } from "../../src/file-tools/grep/fusion.js";
import { packGrepResults, renderGrepSuccess } from "../../src/file-tools/grep/packer.js";
import type { RankedGrepRegion } from "../../src/file-tools/grep/ranker.js";
import { createRankingEvidence } from "../../src/file-tools/ranking-evidence.js";
import { countTextTokensSync } from "../../src/token-counter.js";
import { formatCompactGrepResult, grepWorkspaceFiles } from "../../src/file-tools/tools/grep.js";
import type { GrepMatchMode, GrepSuccess, ToolOutcome } from "../../src/file-tools/types.js";
import type { RepoMapFileToolQuery } from "../../src/repo-map/file-tool-query.js";
import type { RepoMapQueryCandidate, RepoMapQueryResult } from "../../src/repo-map/query.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

let workspace: string;
let outside: string;
const workspaceTemp = useTempDir("o-pi-grep-");
const outsideTemp = useTempDir("o-pi-grep-outside-");
preserveEnv("PI_FILE_TOOLS_CONFIG");

beforeEach(async () => {
	workspace = workspaceTemp.path;
	outside = outsideTemp.path;
	const configPath = path.join(outside, "file-tools.jsonc");
	await writeConfig(configPath);
	process.env.PI_FILE_TOOLS_CONFIG = configPath;
	clearGrepIndex();
});

afterEach(async () => {
	clearGrepIndex();
});

async function writeConfig(configPath: string, limits: Record<string, number> = {}): Promise<void> {
	await writeFile(
		configPath,
		JSON.stringify(
			{
				blocked_path: [".git/"],
				ignored_path: [],
				ignore: { builtin_profile: "none", gitignore: false },
				limits: {
					grep_output_token_budget: 1600,
					grep_result_limit: 8,
					grep_max_file_bytes: 4096,
					grep_max_files_scanned: 100000,
					...limits,
				},
			},
			null,
			2,
		),
	);
}

function expectGrepSuccess(result: ToolOutcome<GrepSuccess>): GrepSuccess {
	if (result.status === "failed") throw new Error(`grep failed: ${result.error.code}: ${result.error.message}`);
	return result;
}

function firstRegion(result: GrepSuccess) {
	const region = result.regions[0];
	if (region === undefined) throw new Error("missing region");
	return region;
}

function repoMapCandidate(
	filePath: string,
	content: string,
	unit: IndexedCodeUnit,
	reasons: RepoMapQueryCandidate["reasons"],
	contentHash = createHash("sha256").update(content).digest("hex"),
): RepoMapQueryCandidate {
	return {
		path: filePath,
		fileId: `file:${filePath}`,
		contentHash,
		symbol: {
			id: unit.id,
			kind: unit.kind,
			...(unit.name !== undefined ? { name: unit.name } : {}),
			...(unit.qualifiedName !== undefined ? { qualifiedName: unit.qualifiedName } : {}),
			...(unit.signature !== undefined ? { signature: unit.signature } : {}),
			range: {
				startLine: unit.startLine,
				endLine: unit.endLine,
				startByte: unit.startByte,
				endByte: unit.endByte,
			},
		},
		range: {
			startLine: unit.startLine,
			endLine: unit.endLine,
			startByte: unit.startByte,
			endByte: unit.endByte,
		},
		score: 900,
		confidence: 1,
		hop: 0,
		reasons,
		matchedAliases: [],
		relatedEdges: [],
	};
}

function repoMapQuery(query: RepoMapFileToolQuery["query"]): RepoMapFileToolQuery {
	return {
		query,
		async readContext() { return undefined; },
		async syncMutation() { return undefined; },
	};
}

async function assertStrictMatches(result: GrepSuccess, query: string, match: Exclude<GrepMatchMode, "auto">): Promise<void> {
	for (const region of result.regions) {
		const text = await readFile(path.join(workspace, region.path), "utf8");
		const lines = text.split(/\n/u);
		expect(region.match_lines?.length).toBeGreaterThan(0);
		for (const lineNumber of region.match_lines ?? []) {
			const line = lines[lineNumber - 1] ?? "";
			expect(match === "literal" ? line.includes(query) : new RegExp(query, "u").test(line)).toBe(true);
		}
	}
}

describe("grep", () => {
	it("紧凑输出共享目录前缀且 signature 模式保留完整签名", () => {
		const output = renderGrepSuccess({
			status: "success",
			query: "handler",
			path: ".",
			match: "auto",
			strategy: ["symbol"],
			total_candidates: 2,
			returned_regions: 2,
			returned_files: 2,
			approx_tokens: 0,
			scanned_files: 2,
			truncated: false,
			regions: [
				{
					path: "src/features/authentication/first-handler.ts",
					start_line: 1,
					end_line: 3,
					kind: "function",
					symbol: "firstHandler",
					signature: "function firstHandler(input: AuthInput): Session",
					detail: "signature",
					reasons: ["exact symbol"],
				},
				{
					path: "src/features/authentication/second-handler.ts",
					start_line: 5,
					end_line: 7,
					kind: "function",
					symbol: "secondHandler",
					detail: "signature",
					reasons: ["caller"],
				},
			],
		});

		expect(output).toContain("in src/features/authentication/");
		expect(output).toContain("first-handler.ts:1-3 function firstHandler(input: AuthInput): Session [exact symbol]");
		expect(output).not.toContain("src/features/authentication/first-handler.ts:1-3");
	});

	it("首个正文超预算时降级为 signature 并严格遵守预算", () => {
		const longLine = `  const value = '${"needle".repeat(80)}';\n`;
		const source = `export function oversizedNeedle(): string {\n${longLine.repeat(80)}  return value;\n}\n`;
		const candidate: RankedGrepRegion = {
			id: "oversized",
			path: "src/oversized.ts",
			kind: "function",
			symbol: "oversizedNeedle",
			signature: "function oversizedNeedle(): string",
			startLine: 1,
			endLine: 83,
			startByte: 0,
			endByte: Buffer.byteLength(source),
			tier: 1,
			evidence: createRankingEvidence("lexical", 1),
			lexicalRelevance: 1,
			pathRelevance: 0,
			reasons: ["exact literal"],
			matchLines: [40],
			callees: [],
			imports: [],
		};
		const result = packGrepResults({
			query: "needle",
			path: ".",
			match: "literal",
			strategy: ["literal"],
			totalCandidates: 1,
			regions: [candidate],
			sourceText: new Map([[candidate.path, source]]),
			tokenBudget: 100,
			resultLimit: 1,
			scanComplete: true,
			scannedFiles: 1,
			nearby: [],
		});

		expect(firstRegion(result).detail).toBe("signature");
		expect(formatCompactGrepResult(result)).toContain("function oversizedNeedle(): string");
		expect(countTextTokensSync(formatCompactGrepResult(result)).tokens).toBeLessThanOrEqual(100);
	});

	it("path 默认 workspace，并按 symbol 返回完整函数", async () => {
		await writeFile(path.join(workspace, "auth.ts"), "export function login() {\n  return issueToken();\n}\n");
		const result = expectGrepSuccess(await grepWorkspaceFiles(workspace, { query: "login" }));
		expect(result).toMatchObject({ status: "success", path: ".", match: "auto" });
		expect(firstRegion(result)).toMatchObject({ path: "auth.ts", symbol: "login", detail: "body" });
		expect(firstRegion(result).content).toContain("export function login()");
		const text = formatCompactGrepResult(result);
		expect(text).toContain("<grep>");
		expect(text).not.toContain('query="login"');
		expect(text).toContain("</grep>");
		expect(text).not.toContain("tokens");
	});

	it("workspace 内绝对 path 会按 workspace-relative path 检索", async () => {
		await mkdir(path.join(workspace, "src"));
		await writeFile(path.join(workspace, "src", "auth.ts"), "export function login() { return true; }\n");
		const result = expectGrepSuccess(await grepWorkspaceFiles(workspace, { path: path.join(workspace, "src"), query: "login" }));
		expect(result).toMatchObject({ status: "success", path: "src" });
		expect(firstRegion(result)).toMatchObject({ path: "src/auth.ts", symbol: "login" });
	});

	it("workspace 外绝对 path 可以检索", async () => {
		await writeFile(path.join(outside, "external.ts"), "export function externalNeedle() { return true; }\n");
		const result = expectGrepSuccess(await grepWorkspaceFiles(workspace, { path: outside, query: "externalNeedle" }));
		expect(result).toMatchObject({ status: "success", path: path.normalize(outside) });
		expect(firstRegion(result)).toMatchObject({ path: path.join(outside, "external.ts"), symbol: "externalNeedle" });
	});

	it("exact symbol 的定义排在引用之前，并以独立 region 表达一跳 caller/callee", async () => {
		await writeFile(path.join(workspace, "service.ts"), "export function login() {\n  return issueToken();\n}\nfunction issueToken() { return 't'; }\n");
		await writeFile(path.join(workspace, "route.ts"), "import { login } from './service';\nexport function handle() {\n  return login();\n}\n");
		const result = expectGrepSuccess(await grepWorkspaceFiles(workspace, { query: "login" }));
		expect(firstRegion(result)).toMatchObject({ path: "service.ts", symbol: "login" });
		expect(result.regions.some((region) => region.symbol === "handle" && region.reasons.includes("caller"))).toBe(true);
		expect(result.regions.some((region) => region.symbol === "issueToken" && region.reasons.includes("callee"))).toBe(true);
		expect(formatCompactGrepResult(result)).not.toContain("calls: issueToken");
	});

	it("支持 qualified symbol", async () => {
		await writeFile(path.join(workspace, "auth.ts"), "export class AuthService {\n  async login(credentials: Credentials): Promise<Session> {\n    return issueToken();\n  }\n}\n");
		const result = expectGrepSuccess(await grepWorkspaceFiles(workspace, { query: "AuthService.login" }));
		expect(firstRegion(result)).toMatchObject({ symbol: "AuthService.login" });
		expect(firstRegion(result).reasons).toContain("exact qualified symbol");
	});

	it("camelCase、snake_case、路径和 docstring 能被自然语言召回", async () => {
		await mkdir(path.join(workspace, "src"));
		await writeFile(path.join(workspace, "src", "session_token.py"), 'def issue_session_token(user):\n    """create authentication flow token"""\n    return user.id\n');
		const result = expectGrepSuccess(await grepWorkspaceFiles(workspace, { query: "authentication flow session token" }));
		expect(firstRegion(result)).toMatchObject({ path: "src/session_token.py", symbol: "issue_session_token" });
		expect(firstRegion(result).reasons).toContain("lexical");
	});

	it("literal 精确且区分大小写，同一函数多处命中只返回一个 region", async () => {
		await writeFile(path.join(workspace, "a.ts"), "export function demo() {\n  const Token = 'Token';\n  const token = 'token';\n  return Token;\n}\n");
		const result = expectGrepSuccess(await grepWorkspaceFiles(workspace, { query: "Token", match: "literal" }));
		expect(result.regions).toHaveLength(1);
		expect(firstRegion(result).match_lines).toEqual([2, 4]);
		expect(firstRegion(result).content).toContain("function demo");
	});

	it("regex 搜索和 INVALID_REGEX", async () => {
		await writeFile(path.join(workspace, "a.ts"), "export function user12() { return 'user_12'; }\nexport function userX() { return 'user_x'; }\n");
		const result = expectGrepSuccess(await grepWorkspaceFiles(workspace, { query: "user_\\d+", match: "regex" }));
		expect(firstRegion(result).reasons).toContain("regex");
		expect(await grepWorkspaceFiles(workspace, { query: "(", match: "regex" })).toMatchObject({ status: "failed", error: { code: "INVALID_REGEX" } });
	});

	it.each([
		{ match: "literal" as const, queryText: "Needle42", expectedReason: "exact literal" },
		{ match: "regex" as const, queryText: "Needle\\d+", expectedReason: "regex" },
	])("$match 严格验证 repo-map region，并增强排序、reasons 和去重", async ({ match, queryText, expectedReason }) => {
		const firstText = "export function Alpha() { return 'Needle42'; }\n";
		const preferredText = "export function Preferred() { return 'Needle42'; }\n";
		const mixedText = "export function Unrelated() { return 'other'; }\nexport function Matching() { return 'Needle42'; }\n";
		const excludedText = "export function Excluded() { return 'other'; }\n";
		await writeFile(path.join(workspace, "a.ts"), firstText);
		await writeFile(path.join(workspace, "z.ts"), preferredText);
		await writeFile(path.join(workspace, "mixed.ts"), mixedText);
		await writeFile(path.join(workspace, "excluded.ts"), excludedText);
		const preferredUnit = parseCodeUnits("z.ts", preferredText).units.find((unit) => unit.name === "Preferred");
		const unrelatedUnit = parseCodeUnits("mixed.ts", mixedText).units.find((unit) => unit.name === "Unrelated");
		const excludedUnit = parseCodeUnits("excluded.ts", excludedText).units.find((unit) => unit.name === "Excluded");
		const firstUnit = parseCodeUnits("a.ts", firstText).units.find((unit) => unit.name === "Alpha");
		if (preferredUnit === undefined || unrelatedUnit === undefined || excludedUnit === undefined || firstUnit === undefined) {
			throw new Error("missing parsed fixture unit");
		}
		const preferred = repoMapCandidate("z.ts", preferredText, preferredUnit, ["definition"]);
		const unrelated = repoMapCandidate("mixed.ts", mixedText, unrelatedUnit, ["caller"]);
		const query = vi.fn(async (input): Promise<RepoMapQueryResult> => ({
			root: workspace,
			explanation: { queryTerms: [input.query], expandedTerms: [input.query], seedCount: 1, maxHop: 2 },
			candidates: [
				preferred,
				{ ...preferred, reasons: ["public api"] },
				unrelated,
				{ ...unrelated, reasons: ["test"] },
				repoMapCandidate("excluded.ts", excludedText, excludedUnit, ["exact symbol"]),
				repoMapCandidate("a.ts", firstText, firstUnit, ["public api"], "stale-hash"),
			],
		}));

		const result = expectGrepSuccess(await grepWorkspaceFiles(
			workspace,
			{ query: queryText, match },
			undefined,
			{ repoMap: repoMapQuery(query) },
		));

		expect(query).toHaveBeenCalledWith({ requestedPath: workspace, query: match === "regex" ? "Needle" : queryText, limit: 32 });
		expect(result.strategy).toContain("repo-map");
		expect(firstRegion(result)).toMatchObject({ path: "z.ts", symbol: "Preferred" });
		expect(firstRegion(result).reasons).toEqual(expect.arrayContaining([expectedReason, "definition", "public api"]));
		const compact = formatCompactGrepResult(result);
		expect(compact).toContain("definition");
		expect(compact).not.toContain(expectedReason);
		expect(compact).not.toContain("hop 1");
		expect(result.regions.filter((region) => region.path === "z.ts" && region.symbol === "Preferred")).toHaveLength(1);
		expect(result.regions.some((region) => region.symbol === "Unrelated")).toBe(false);
		expect(result.regions.some((region) => region.path === "excluded.ts")).toBe(false);
		expect(result.related).toEqual(expect.arrayContaining([
			expect.objectContaining({ path: "mixed.ts", symbol: "Unrelated", source: "repo-map", relations: ["caller", "test"], query_match: "not_guaranteed" }),
		]));
		expect(result.related?.length).toBeLessThanOrEqual(3);
		expect(compact).toContain("<related repo-map nonmatch>");
		expect(compact).toContain("export function Unrelated() { return 'other'; } [caller,test]");
		expect(compact).not.toMatch(/[·→]/u);
		expect(result.regions.find((region) => region.path === "a.ts")?.reasons).not.toContain("public api");
		await assertStrictMatches(result, queryText, match);
	});

	it("严格主结果为空时单独返回有界的 Repo Map 关联区域", async () => {
		const content = "export function RelatedDefinition() { return 'other'; }\n";
		await writeFile(path.join(workspace, "related.ts"), content);
		const unit = parseCodeUnits("related.ts", content).units.find((item) => item.name === "RelatedDefinition");
		if (unit === undefined) throw new Error("missing parsed fixture unit");
		const query = vi.fn(async (input): Promise<RepoMapQueryResult> => ({
			root: workspace,
			explanation: { queryTerms: [input.query], expandedTerms: [input.query], seedCount: 1, maxHop: 2 },
			candidates: [repoMapCandidate("related.ts", content, unit, ["definition"])],
		}));

		const result = expectGrepSuccess(await grepWorkspaceFiles(
			workspace,
			{ query: "MissingNeedle", match: "literal" },
			undefined,
			{ repoMap: repoMapQuery(query) },
		));

		expect(result.regions).toEqual([]);
		expect(result.strategy).not.toContain("repo-map");
		expect(result.related).toEqual([expect.objectContaining({
			path: "related.ts",
			symbol: "RelatedDefinition",
			source: "repo-map",
			relations: ["definition"],
			query_match: "not_guaranteed",
		})]);
		const compact = formatCompactGrepResult(result);
		expect(compact).toContain("none");
		expect(compact).toContain("<related repo-map nonmatch>");
		expect(countTextTokensSync(compact).tokens).toBeLessThanOrEqual(1600);
	});

	it("grep glob 之外的 Repo Map 候选只能进入关联通道", async () => {
		await mkdir(path.join(workspace, "src"));
		await mkdir(path.join(workspace, "tests"));
		await writeFile(path.join(workspace, "src", "match.ts"), "export const match = 'Needle42';\n");
		const relatedText = "export function RelatedTest() { return 'Needle42'; }\n";
		await writeFile(path.join(workspace, "tests", "related.test.ts"), relatedText);
		const relatedUnit = parseCodeUnits("tests/related.test.ts", relatedText).units.find((item) => item.name === "RelatedTest");
		if (relatedUnit === undefined) throw new Error("missing parsed fixture unit");
		const query = vi.fn(async (input): Promise<RepoMapQueryResult> => ({
			root: workspace,
			explanation: { queryTerms: [input.query], expandedTerms: [input.query], seedCount: 1, maxHop: 2 },
			candidates: [repoMapCandidate("tests/related.test.ts", relatedText, relatedUnit, ["test"])],
		}));

		const result = expectGrepSuccess(await grepWorkspaceFiles(
			workspace,
			{ query: "Needle42", match: "literal", glob: "src/**/*.ts" },
			undefined,
			{ repoMap: repoMapQuery(query) },
		));

		expect(result.regions.map((region) => region.path)).toEqual(["src/match.ts"]);
		expect(result.related).toEqual([expect.objectContaining({
			path: "tests/related.test.ts",
			relations: ["test"],
			query_match: "not_guaranteed",
		})]);
	});

	it("严格主结果充足时不返回结构关联通道", async () => {
		for (const name of ["a", "b", "c", "d"]) {
			await writeFile(path.join(workspace, `${name}.ts`), `export const ${name} = 'Needle42';\n`);
		}
		const relatedText = "export function RelatedDefinition() { return 'other'; }\n";
		await writeFile(path.join(workspace, "related.ts"), relatedText);
		const unit = parseCodeUnits("related.ts", relatedText).units.find((item) => item.name === "RelatedDefinition");
		if (unit === undefined) throw new Error("missing parsed fixture unit");
		const query = vi.fn(async (input): Promise<RepoMapQueryResult> => ({
			root: workspace,
			explanation: { queryTerms: [input.query], expandedTerms: [input.query], seedCount: 1, maxHop: 2 },
			candidates: [repoMapCandidate("related.ts", relatedText, unit, ["definition"])],
		}));

		const result = expectGrepSuccess(await grepWorkspaceFiles(
			workspace,
			{ query: "Needle42", match: "literal" },
			undefined,
			{ repoMap: repoMapQuery(query) },
		));

		expect(result.regions).toHaveLength(4);
		expect(result.related).toBeUndefined();
	});

	it("只在最终打包结果使用结构增强时标记 repo-map strategy", () => {
		const native: RankedGrepRegion = {
			id: "native",
			path: "native.ts",
			kind: "function",
			startLine: 1,
			endLine: 1,
			startByte: 0,
			endByte: 1,
			tier: 1,
			evidence: createRankingEvidence("lexical", 1),
			lexicalRelevance: 0,
			pathRelevance: 0,
			reasons: ["exact literal"],
			matchLines: [1],
			callees: [],
			imports: [],
		};
		const structural: RankedGrepRegion = {
			...native,
			id: "structural",
			path: "structural.ts",
			evidence: createRankingEvidence("structural", 1),
			reasons: ["exact literal", "definition"],
			repoMap: true,
		};
		const result = packGrepResults({
			query: "needle",
			path: ".",
			match: "literal",
			strategy: ["literal", "repo-map"],
			totalCandidates: 2,
			regions: [native, structural],
			sourceText: new Map(),
			tokenBudget: 200,
			resultLimit: 1,
			scanComplete: true,
			scannedFiles: 2,
			nearby: [],
		});

		expect(result.strategy).toEqual(["literal"]);
		expect(formatCompactGrepResult(result)).toContain("<grep truncated>");
		expect(formatCompactGrepResult(result)).not.toContain("repo-map");
	});

	it("单次融合跨通道共识且不修改输入候选", () => {
		const native: RankedGrepRegion = {
			id: "native",
			path: "target.ts",
			kind: "function",
			symbol: "Target",
			startLine: 2,
			endLine: 4,
			startByte: 10,
			endByte: 40,
			tier: 3,
			evidence: createRankingEvidence("structural", 0.8),
			lexicalRelevance: 0,
			pathRelevance: 0,
			reasons: ["exact symbol"],
			matchLines: [2],
			callees: [],
			imports: [],
		};
		const semantic: RankedGrepRegion = {
			...native,
			id: "lsp",
			symbol: "target",
			evidence: createRankingEvidence("semantic", 0.6),
			reasons: ["lsp symbol"],
			matchLines: [3],
		};

		const merged = mergeRankedGrepSources([native], [semantic], []);

		expect(merged).toHaveLength(1);
		expect(merged[0]?.evidence.familyCount).toBe(2);
		expect(merged[0]?.reasons).toEqual(["exact symbol", "lsp symbol"]);
		expect(merged[0]?.matchLines).toEqual([2, 3]);
		expect(native.reasons).toEqual(["exact symbol"]);
		expect(native.matchLines).toEqual([2]);
	});

	it("AST/LSP 同一 symbol 的范围相差两行仍合并，但 overload signature 不合并", () => {
		const base: RankedGrepRegion = {
			id: "ast-a",
			path: "target.ts",
			kind: "function",
			symbol: "Target",
			signature: "function Target(value: string)",
			startLine: 10,
			endLine: 14,
			startByte: 100,
			endByte: 180,
			tier: 3,
			evidence: createRankingEvidence("structural", 1),
			lexicalRelevance: 0,
			pathRelevance: 0,
			reasons: ["exact symbol"],
			matchLines: [],
			callees: [],
			imports: [],
		};
		const { signature: _signature, ...withoutSignature } = base;
		const lsp: RankedGrepRegion = {
			...withoutSignature,
			id: "lsp",
			kind: "Function",
			startLine: 8,
			endLine: 10,
			evidence: createRankingEvidence("semantic", 1),
			reasons: ["lsp exact symbol"],
		};
		expect(mergeRankedGrepSources([base], [lsp])).toHaveLength(1);

		const overload: RankedGrepRegion = {
			...base,
			id: "ast-b",
			signature: "function Target(value: number)",
			startLine: 11,
			endLine: 15,
		};
		expect(mergeRankedGrepSources([base, overload], [])).toHaveLength(2);
	});

	it("无 symbol/range 的 Repo Map 文件候选不会投影到 units[0]", async () => {
		const content = "export function FirstFunction() { return 1; }\nexport function SecondFunction() { return 2; }\n";
		await writeFile(path.join(workspace, "ambiguous.ts"), content);
		const candidate: RepoMapQueryCandidate = {
			path: "ambiguous.ts",
			fileId: "file:ambiguous.ts",
			contentHash: createHash("sha256").update(content).digest("hex"),
			score: 900,
			confidence: 1,
			hop: 0,
			reasons: ["definition"],
			matchedAliases: [],
			relatedEdges: [],
		};
		const result = expectGrepSuccess(await grepWorkspaceFiles(workspace, { query: "MissingTarget" }, undefined, {
			repoMap: repoMapQuery(async (input) => ({
				root: workspace,
				explanation: { queryTerms: [input.query], expandedTerms: [input.query], seedCount: 1, maxHop: 2 },
				candidates: [candidate],
			})),
		}));
		expect(result.regions.some((region) => region.symbol === "FirstFunction")).toBe(false);
		expect(result.related).toEqual([expect.objectContaining({ path: "ambiguous.ts", kind: "file" })]);
		expect(result.related?.[0]?.symbol).toBeUndefined();
	});

	it.each(["literal", "regex"] as const)("%s 在 repo-map 查询失效时保持原结果", async (match) => {
		const content = "export function Target() { return 'Needle42'; }\n";
		await writeFile(path.join(workspace, "target.ts"), content);
		const queryText = match === "literal" ? "Needle42" : "Needle\\d+";
		const baseline = expectGrepSuccess(await grepWorkspaceFiles(workspace, { query: queryText, match }));
		clearGrepIndex();
		const query = vi.fn(async () => { throw new Error("repo-map unavailable"); });
		const degraded = expectGrepSuccess(await grepWorkspaceFiles(
			workspace,
			{ query: queryText, match },
			undefined,
			{ repoMap: repoMapQuery(query) },
		));

		expect(query).toHaveBeenCalledTimes(1);
		expect(degraded).toEqual(baseline);
	});

	it("无字面标识片段的 regex 不发起无收益的 repo-map 查询", async () => {
		await writeFile(path.join(workspace, "number.ts"), "export const value = 42;\n");
		const query = vi.fn(async (): Promise<RepoMapQueryResult | undefined> => undefined);
		const result = expectGrepSuccess(await grepWorkspaceFiles(
			workspace,
			{ query: "\\d+", match: "regex" },
			undefined,
			{ repoMap: repoMapQuery(query) },
		));

		expect(result.regions.length).toBeGreaterThan(0);
		expect(query).not.toHaveBeenCalled();
	});

	it("超大函数围绕命中压缩并保留 signature", async () => {
		const configPath = path.join(outside, "small-budget.jsonc");
		await writeConfig(configPath, { grep_output_token_budget: 220, grep_result_limit: 4 });
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		const body = Array.from({ length: 80 }, (_, index) => `  const value${index} = ${index};`).join("\n");
		await writeFile(path.join(workspace, "large.ts"), `export function hugeFunction() {\n${body}\n  return needle;\n}\n`);
		const result = expectGrepSuccess(await grepWorkspaceFiles(workspace, { query: "needle", match: "literal" }));
		expect(firstRegion(result).detail).toBe("snippet");
		expect(firstRegion(result).signature).toContain("hugeFunction");
		expect(firstRegion(result).content).toContain("needle");
		expect(countTextTokensSync(formatCompactGrepResult(result)).tokens).toBeLessThanOrEqual(220);
	});

	it("多文件结果先覆盖不同文件，test 查询把测试意图作为来源内排序依据", async () => {
		await writeFile(path.join(workspace, "service.ts"), "export function login() { return true; }\n");
		await writeFile(path.join(workspace, "service.test.ts"), "export function loginTest() { return login(); }\n");
		await writeFile(path.join(workspace, "controller.ts"), "export function handleLogin() { return login(); }\n");
		const result = expectGrepSuccess(await grepWorkspaceFiles(workspace, { query: "login" }));
		expect(new Set(result.regions.slice(0, 3).map((region) => region.path)).size).toBeGreaterThan(1);
		expect(firstRegion(result).path).not.toContain("test");
		const testResult = expectGrepSuccess(await grepWorkspaceFiles(workspace, { query: "login test" }));
		expect(testResult.regions[0]?.path).toContain("test");
	});

	it("文件修改、删除和 ignore 变化会更新索引", async () => {
		await writeFile(path.join(workspace, "a.ts"), "export function oldName() {}\n");
		expect(firstRegion(expectGrepSuccess(await grepWorkspaceFiles(workspace, { query: "oldName" }))).symbol).toBe("oldName");
		await writeFile(path.join(workspace, "a.ts"), "export function newName() {}\n");
		expect(firstRegion(expectGrepSuccess(await grepWorkspaceFiles(workspace, { query: "newName" }))).symbol).toBe("newName");
		await rm(path.join(workspace, "a.ts"));
		expect(expectGrepSuccess(await grepWorkspaceFiles(workspace, { query: "newName" })).regions).toHaveLength(0);
		await writeFile(path.join(workspace, ".piignore"), "ignored.ts\n");
		await writeFile(path.join(workspace, "ignored.ts"), "export function hiddenNeedle() {}\n");
		expect(expectGrepSuccess(await grepWorkspaceFiles(workspace, { query: "hiddenNeedle" })).regions).toHaveLength(0);
	});

	it("显式 grep 允许读取 soft ignored 文件和目录内容", async () => {
		await writeFile(path.join(workspace, ".piignore"), "ignored.ts\nignored-dir/\n");
		await mkdir(path.join(workspace, "ignored-dir"));
		await writeFile(path.join(workspace, "ignored.ts"), "export function hiddenFileNeedle() {}\n");
		await writeFile(path.join(workspace, "ignored-dir", "secret.ts"), "export function hiddenDirNeedle() {}\n");

		expect(expectGrepSuccess(await grepWorkspaceFiles(workspace, { query: "hiddenFileNeedle" })).regions).toHaveLength(0);
		expect(expectGrepSuccess(await grepWorkspaceFiles(workspace, { query: "hiddenDirNeedle" })).regions).toHaveLength(0);
		expect(firstRegion(expectGrepSuccess(await grepWorkspaceFiles(workspace, { path: "ignored.ts", query: "hiddenFileNeedle" })))).toMatchObject({
			path: "ignored.ts",
			symbol: "hiddenFileNeedle",
		});
		expect(firstRegion(expectGrepSuccess(await grepWorkspaceFiles(workspace, { path: "ignored-dir", query: "hiddenDirNeedle" })))).toMatchObject({
			path: "ignored-dir/secret.ts",
			symbol: "hiddenDirNeedle",
		});
	});

	it("大目录缓存命中后二次 grep 不重新读取全部文件源码", async () => {
		for (let index = 0; index < 60; index += 1) {
			await writeFile(path.join(workspace, `module-${index}.ts`), `export function helper${index}() {\n  return ${index};\n}\n`);
		}
		await writeFile(path.join(workspace, "target.ts"), "export function targetNeedle() {\n  return 42;\n}\n");
		expect(firstRegion(expectGrepSuccess(await grepWorkspaceFiles(workspace, { query: "targetNeedle" }))).symbol).toBe("targetNeedle");

		let sourceReads = 0;
		const result = expectGrepSuccess(
			await grepWorkspaceFiles(workspace, { query: "targetNeedle" }, undefined, {
				readSourceText: async (file) => {
					sourceReads += 1;
					return await readFile(file.absolutePath, "utf8");
				},
			}),
		);

		expect(firstRegion(result).content).toContain("targetNeedle");
		expect(sourceReads).toBeLessThan(10);
	});

	it("缓存索引的候选源码使用有界并发加载", async () => {
		for (let index = 0; index < 8; index += 1) {
			await writeFile(path.join(workspace, `candidate-${index}.ts`), `export function needle${index}() { return "needle"; }\n`);
		}
		expectGrepSuccess(await grepWorkspaceFiles(workspace, { query: "warmup" }));

		let activeReads = 0;
		let maxActiveReads = 0;
		const result = expectGrepSuccess(await grepWorkspaceFiles(workspace, { query: "needle", match: "literal" }, undefined, {
			readSourceText: async (file) => {
				activeReads += 1;
				maxActiveReads = Math.max(maxActiveReads, activeReads);
				try {
					return await readFile(file.absolutePath, "utf8");
				} finally {
					activeReads -= 1;
				}
			},
		}));

		expect(result.regions.length).toBeGreaterThan(1);
		expect(maxActiveReads).toBeGreaterThan(1);
		expect(maxActiveReads).toBeLessThanOrEqual(8);
	});

	it("unsupported language 安全退化到文本片段", async () => {
		await writeFile(path.join(workspace, "notes.conf"), "section=true\nfatal authentication error\n");
		const result = expectGrepSuccess(await grepWorkspaceFiles(workspace, { query: "fatal authentication error", match: "literal" }));
		expect(firstRegion(result)).toMatchObject({ path: "notes.conf", kind: "text", detail: "snippet" });

		const auto = expectGrepSuccess(await grepWorkspaceFiles(workspace, { query: "authentication error" }));
		expect(firstRegion(auto)).toMatchObject({ path: "notes.conf", kind: "text", reasons: ["exact literal"] });
		const warmLexical = expectGrepSuccess(await grepWorkspaceFiles(workspace, { query: "fatal error" }));
		expect(firstRegion(warmLexical)).toMatchObject({ path: "notes.conf", kind: "text", reasons: ["lexical"] });
	});

	it("binary、invalid UTF-8、too large、blocked path 和 symlink 行为保持", async () => {
		await writeFile(path.join(workspace, "ok.txt"), "needle\n");
		await writeFile(path.join(workspace, "binary.bin"), Buffer.from([0, 1, 2]));
		await writeFile(path.join(workspace, "bad.txt"), Buffer.from([0xc3, 0x28]));
		await writeFile(path.join(workspace, "large.txt"), `${"x".repeat(5000)}needle\n`);
		const result = expectGrepSuccess(await grepWorkspaceFiles(workspace, { query: "needle", match: "literal" }));
		expect(result.skipped_files).toMatchObject({ binary: 1, invalid_utf8: 1, too_large: 1 });
		await mkdir(path.join(workspace, ".git"));
		await writeFile(path.join(workspace, ".git", "config"), "needle\n");
		expect(await grepWorkspaceFiles(workspace, { path: ".git/config", query: "needle" })).toMatchObject({ status: "failed", error: { code: "PROTECTED_PATH" } });
		await writeFile(path.join(outside, "secret.txt"), "needle\n");
		try {
			await symlink(path.join(outside, "secret.txt"), path.join(workspace, "link.txt"));
		} catch {
			return;
		}
		expect(firstRegion(expectGrepSuccess(await grepWorkspaceFiles(workspace, { path: "link.txt", query: "needle", match: "literal" })))).toMatchObject({
			path: "link.txt",
		});
		const configPath = path.join(outside, "blocked-realpath.jsonc");
		await writeConfig(configPath);
		const raw = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
		raw.blocked_path = [`${outside}/`];
		await writeFile(configPath, JSON.stringify(raw, null, 2));
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		clearGrepIndex();
		expect(await grepWorkspaceFiles(workspace, { path: "link.txt", query: "needle" })).toMatchObject({
			status: "failed",
			error: { code: "PROTECTED_PATH" },
		});
	});

	it.skipIf(process.platform === "win32")("递归搜索跳过局部权限失败", async () => {
		await writeFile(path.join(workspace, "ok.txt"), "needle\n");
		await mkdir(path.join(workspace, "locked"));
		await writeFile(path.join(workspace, "locked", "secret.txt"), "needle\n");
		await chmod(path.join(workspace, "locked"), 0o000);
		try {
			const result = expectGrepSuccess(await grepWorkspaceFiles(workspace, { query: "needle", match: "literal" }));
			expect(result.skipped_files).toMatchObject({ access_denied: 1 });
		} finally {
			await chmod(path.join(workspace, "locked"), 0o700);
		}
	});

	it("AbortSignal、稳定排序、零结果和相近 symbol", async () => {
		await writeFile(path.join(workspace, "b.ts"), "export function betaSearch() {}\n");
		await writeFile(path.join(workspace, "a.ts"), "export function alphaSearch() {}\n");
		const first = expectGrepSuccess(await grepWorkspaceFiles(workspace, { query: "Search" }));
		const second = expectGrepSuccess(await grepWorkspaceFiles(workspace, { query: "Search" }));
		expect(first.regions.map((region) => region.path)).toEqual(second.regions.map((region) => region.path));
		const zero = expectGrepSuccess(await grepWorkspaceFiles(workspace, { query: "alpha missing" }));
		expect(zero.regions).toHaveLength(0);
		expect(zero.nearby).toEqual(expect.arrayContaining([
			expect.objectContaining({ symbol: "alphaSearch", reason: "partial terms" }),
		]));
		const controller = new AbortController();
		controller.abort();
		expect(await grepWorkspaceFiles(workspace, { query: "Search" }, controller.signal)).toMatchObject({ status: "failed", error: { code: "OPERATION_ABORTED" } });
	});

	it("auto 的 symbol typo 只进入带范围和原因的 nearby 非命中通道", async () => {
		await writeFile(path.join(workspace, "auth.ts"), "export function authenticate() { return true; }\n");

		const result = expectGrepSuccess(await grepWorkspaceFiles(workspace, { query: "authentcate" }));

		expect(result.regions).toEqual([]);
		expect(result.nearby).toEqual([
			expect.objectContaining({
				path: "auth.ts",
				symbol: "authenticate",
				reason: "symbol similarity",
				start_line: 1,
			}),
		]);
		const compact = formatCompactGrepResult(result);
		expect(compact).toContain("<nearby nonmatch>");
		expect(compact).toContain("auth.ts:1 authenticate [symbol similarity]");
		expect(compact).toContain("</nearby>");
	});

	it.each([
		{ match: "literal" as const, query: "MissingNeedle" },
		{ match: "regex" as const, query: "Missing\\d+" },
	])("$match 零命中返回扫描范围和可执行下一步", async ({ match, query }) => {
		await writeFile(path.join(workspace, "auth.ts"), "export function authenticateUser() { return true; }\n");

		const result = expectGrepSuccess(await grepWorkspaceFiles(workspace, { query, match }));

		expect(result.regions).toEqual([]);
		expect(result.nearby).toBeUndefined();
		expect(result.scanned_files).toBe(1);
		expect(formatCompactGrepResult(result)).toBe([
			"<grep>",
			"none",
			"searched=1; skipped=0",
			"next: use match=auto or broaden path",
			"</grep>",
		].join("\n"));
	});

	it("共享索引构建时单个调用取消不影响其他调用", async () => {
		for (let index = 0; index < 60; index += 1) {
			await writeFile(path.join(workspace, `module-${index}.ts`), `export function symbol${index}() { return ${index}; }\n`);
		}
		await writeFile(path.join(workspace, "target.ts"), "export function sharedTarget() { return true; }\n");
		const controller = new AbortController();
		const aborted = grepWorkspaceFiles(workspace, { query: "symbol0" }, controller.signal);
		const completed = grepWorkspaceFiles(workspace, { query: "sharedTarget" });
		setImmediate(() => controller.abort());

		expect(await aborted).toMatchObject({ status: "failed", error: { code: "OPERATION_ABORTED" } });
		expect(firstRegion(expectGrepSuccess(await completed)).symbol).toBe("sharedTarget");
	});

	it("token-efficiency fixture：高频命中合并，预算内至少一个完整函数，其余 signature", async () => {
		const configPath = path.join(outside, "budget.jsonc");
		await writeConfig(configPath, { grep_output_token_budget: 260, grep_result_limit: 6 });
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		await writeFile(path.join(workspace, "main.ts"), `export function importantNeedle() {\n  return "${"needle ".repeat(30)}";\n}\n`);
		await writeFile(path.join(workspace, "other.ts"), "export function otherNeedle() { return 'needle'; }\nexport function thirdNeedle() { return 'needle'; }\n");
		const result = expectGrepSuccess(await grepWorkspaceFiles(workspace, { query: "needle", match: "literal" }));
		expect(result.regions.filter((region) => region.path === "main.ts")).toHaveLength(1);
		expect(result.regions.some((region) => region.detail === "body")).toBe(true);
		expect(result.regions.some((region) => region.detail === "signature")).toBe(true);
		expect(countTextTokensSync(formatCompactGrepResult(result)).tokens).toBeLessThanOrEqual(260);
	});
});
