import { createHash } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mergeRankedFindSources } from "../../src/file-tools/find/fusion.js";
import { createFindEntry } from "../../src/file-tools/find/ranker.js";
import { renderFindResults } from "../../src/file-tools/find/renderer.js";
import { createRankingEvidence } from "../../src/file-tools/ranking-evidence.js";
import { findWorkspaceFiles } from "../../src/file-tools/tools/find.js";
import { countTextTokensSync } from "../../src/token-counter.js";
import type { FindMatch, FindSuccess, ToolOutcome } from "../../src/file-tools/types.js";
import type { RepoMapFileToolQuery } from "../../src/repo-map/file-tool-query.js";
import type { RepoMapQueryCandidate, RepoMapQueryResult } from "../../src/repo-map/query.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

let workspace: string;
let outside: string;
const workspaceTemp = useTempDir("o-pi-find-");
const outsideTemp = useTempDir("o-pi-find-outside-");
preserveEnv("PI_FILE_TOOLS_CONFIG");

beforeEach(async () => {
	workspace = workspaceTemp.path;
	outside = outsideTemp.path;
	const configPath = path.join(outside, "file-tools.jsonc");
	await writeFile(
		configPath,
		[
			"{",
			'  "blocked_path": [".git/"],',
			'  "ignored_path": [],',
			'  "ignore": { "builtin_profile": "none", "gitignore": false }',
			"}",
		].join("\n"),
	);
	process.env.PI_FILE_TOOLS_CONFIG = configPath;
});

function expectFindSuccess(result: ToolOutcome<FindSuccess>): FindSuccess {
	if ("status" in result) throw new Error(`find failed: ${result.error.code}: ${result.error.message}`);
	return result;
}

function paths(matches: FindMatch[]): string[] {
	return matches.map((match) => match.path);
}

async function writeFixture(filePath: string): Promise<void> {
	await mkdir(path.dirname(path.join(workspace, filePath)), { recursive: true });
	await writeFile(path.join(workspace, filePath), "");
}

function repoMapCandidate(
	filePath: string,
	content: string,
	reasons: RepoMapQueryCandidate["reasons"],
	overrides: Partial<Pick<RepoMapQueryCandidate, "score" | "confidence" | "hop">> = {},
): RepoMapQueryCandidate {
	return {
		path: filePath,
		fileId: `file:${filePath}`,
		contentHash: createHash("sha256").update(content).digest("hex"),
		score: overrides.score ?? 900,
		confidence: overrides.confidence ?? 1,
		hop: overrides.hop ?? 0,
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

describe("find", () => {
	it("紧凑输出省略可推导元数据、共享路径前缀并把截断状态放在首行", () => {
		const base = {
			query: "handler",
			path: ".",
			strategy: "fuzzy" as const,
			totalMatches: 2,
			scannedEntries: 20,
			matches: [
				{ path: "src/features/authentication/first-handler.ts", kind: "file" as const },
				{ path: "src/features/authentication/second-handler.ts", kind: "file" as const },
			],
			ignoredCount: 0,
			skippedCount: 0,
			scanTruncated: false,
			resultLimited: false,
			outputTokenBudget: 1_000,
		};
		const compact = renderFindResults(base);
		expect(compact.content).toBe([
			"in src/features/authentication/",
			"  first-handler.ts",
			"  second-handler.ts",
		].join("\n"));

		const constrained = renderFindResults({ ...base, scanTruncated: true, outputTokenBudget: 14 });
		expect(constrained.content.split("\n")[0]).toBe("found>=2; truncated=scan,output");
		expect(constrained.details).toMatchObject({ scanTruncated: true, resultLimited: false, outputTruncated: true });
		expect(countTextTokensSync(constrained.content).tokens).toBeLessThanOrEqual(14);
	});

	it("nearby 候选超预算时不输出残缺标签，并退回扫描摘要", () => {
		const result = renderFindResults({
			query: "missing",
			path: ".",
			strategy: "fuzzy",
			totalMatches: 0,
			scannedEntries: 12,
			matches: [],
			ignoredCount: 1,
			skippedCount: 2,
			scanTruncated: false,
			resultLimited: false,
			outputTokenBudget: 32,
			nearby: [{ path: `src/${"very-long-segment-".repeat(20)}.ts`, kind: "file", reason: "name similarity" }],
		});

		expect(result.content).not.toContain("<nearby");
		expect(result.content).toContain("searched=12; ignored=1; skipped=2");
		expect(result.details.nearby).toBeUndefined();
		expect(result.details.outputTruncated).toBe(false);
		expect(countTextTokensSync(result.content).tokens).toBeLessThanOrEqual(32);
	});

	it("Repo Map 多关系使用紧凑 ASCII 分隔符", () => {
		const result = renderFindResults({
			query: "login",
			path: ".",
			strategy: "fuzzy",
			totalMatches: 0,
			scannedEntries: 3,
			matches: [],
			ignoredCount: 0,
			skippedCount: 0,
			scanTruncated: false,
			resultLimited: false,
			outputTokenBudget: 200,
			related: [{
				path: "tests/login.test.ts",
				kind: "file",
				source: "repo-map",
				relations: ["caller", "test"],
				query_match: "not_guaranteed",
			}],
		});

		expect(result.content).toContain("tests/login.test.ts [caller,test]");
		expect(result.content).not.toMatch(/[·→]/u);
	});

	it("路径与结构通道融合时不修改输入候选", () => {
		const entry = createFindEntry("src/target.ts", "file");
		const lexical = { entry, tier: 3, evidence: createRankingEvidence("lexical", 0.8) };
		const structural = { entry, tier: 2, evidence: createRankingEvidence("structural", 0.6) };

		const merged = mergeRankedFindSources([lexical], [structural]);

		expect(merged).toHaveLength(1);
		expect(merged[0]?.tier).toBe(2);
		expect(merged[0]?.evidence.familyCount).toBe(2);
		expect(lexical.tier).toBe(3);
		expect(lexical.evidence.familyCount).toBe(1);
	});
	it("使用独立 query/glob schema，默认从 workspace root 搜索并拒绝旧 pattern", async () => {
		await writeFixture("src/nested/a.ts");
		await writeFixture("root.ts");
		await writeFixture("note.txt");

		const result = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "ts", glob: "**/*.ts" }));
		expect(result.details).toMatchObject({
			query: "ts",
			path: ".",
			glob: "**/*.ts",
			strategy: "fuzzy",
			totalMatches: 2,
			returnedMatches: 2,
			scanTruncated: false,
			resultLimited: false,
			outputTruncated: false,
		});
		expect(paths(result.details.matches)).toEqual(["root.ts", "src/nested/a.ts"]);
		expect(await findWorkspaceFiles(workspace, { pattern: "**/*.ts" } as never)).toMatchObject({
			status: "failed",
			error: { code: "INVALID_PATH" },
		});
	});

	it("校验空值、NUL 和越界 query/glob，但允许 workspace 外搜索路径", async () => {
		expect(await findWorkspaceFiles(workspace, { query: "" })).toMatchObject({ status: "failed", error: { code: "INVALID_PATH" } });
		expect(await findWorkspaceFiles(workspace, { query: "a\0b" })).toMatchObject({ status: "failed", error: { code: "INVALID_PATH" } });
		expect(await findWorkspaceFiles(workspace, { query: "/tmp/a" })).toMatchObject({ status: "failed", error: { code: "INVALID_PATH" } });
		expect(await findWorkspaceFiles(workspace, { query: "../a" })).toMatchObject({ status: "failed", error: { code: "INVALID_PATH" } });
		expect(await findWorkspaceFiles(workspace, { path: "", query: "a" })).toMatchObject({ status: "failed", error: { code: "INVALID_PATH" } });
		for (const glob of ["", "a\0b", "/tmp/*.ts", "../*.ts", "src/../../*.ts"]) {
			expect(await findWorkspaceFiles(workspace, { query: "a", glob })).toMatchObject({ status: "failed", error: { code: "INVALID_PATH" } });
		}
		await writeFile(path.join(outside, "external.ts"), "");
		const external = expectFindSuccess(await findWorkspaceFiles(workspace, { path: outside, query: "external.ts" }));
		expect(external.details).toMatchObject({
			path: path.normalize(outside),
			strategy: "exact",
			matches: [{ path: path.join(outside, "external.ts"), kind: "file" }],
		});
	});

	it("workspace 内绝对 path/query 会按 workspace-relative path 解析", async () => {
		await writeFixture("src/auth/service.ts");
		await writeFixture("src/auth/session.ts");

		const absoluteQuery = expectFindSuccess(await findWorkspaceFiles(workspace, { query: path.join(workspace, "src", "auth", "service.ts") }));
		expect(absoluteQuery.details).toMatchObject({
			query: "src/auth/service.ts",
			path: ".",
			strategy: "exact",
			matches: [{ path: "src/auth/service.ts", kind: "file" }],
		});

		const absoluteRoot = expectFindSuccess(await findWorkspaceFiles(workspace, { path: path.join(workspace, "src", "auth"), query: "session.ts" }));
		expect(absoluteRoot.details).toMatchObject({
			query: "session.ts",
			path: "src/auth",
			strategy: "exact",
			matches: [{ path: "src/auth/session.ts", kind: "file" }],
		});

		const absoluteQueryUnderRoot = expectFindSuccess(
			await findWorkspaceFiles(workspace, { path: "src", query: path.join(workspace, "src", "auth", "service.ts") }),
		);
		expect(absoluteQueryUnderRoot.details).toMatchObject({
			query: "auth/service.ts",
			path: "src",
			strategy: "exact",
			matches: [{ path: "src/auth/service.ts", kind: "file" }],
		});
	});

	it("精确文件和目录路径直接返回，且目录带尾随 slash", async () => {
		await mkdir(path.join(workspace, "src", "auth"), { recursive: true });
		await writeFile(path.join(workspace, "src", "auth", "service.ts"), "");
		for (let index = 0; index < 20; index += 1) await writeFixture(`many/file-${index}.ts`);

		const file = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "src/auth/service.ts" }));
		expect(file.details.strategy).toBe("exact");
		expect(file.details.scannedEntries).toBe(0);
		expect(file.content).toContain("src/auth/service.ts");

		const directory = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "src/auth" }));
		expect(directory.details.matches).toEqual([{ path: "src/auth", kind: "directory" }]);
		expect(directory.content).toContain("src/auth/");
	});

	it("query 不再推断 glob，普通括号仍按路径名称处理", async () => {
		await writeFixture("foo(bar)");
		await writeFixture("fooXbar");

		const exact = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "foo(bar)" }));
		expect(exact.details.strategy).toBe("exact");
		expect(paths(exact.details.matches)).toEqual(["foo(bar)"]);
	});

	it("glob 会过滤 exact 命中，随后继续 query 排名", async () => {
		await writeFixture("service.ts");
		await writeFixture("src/service.ts");

		const result = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "service.ts", glob: "src/**/*.ts" }));
		expect(result.details).toMatchObject({ glob: "src/**/*.ts", strategy: "fuzzy" });
		expect(paths(result.details.matches)).toEqual(["src/service.ts"]);
		expect(result.content).toBe("src/service.ts");

		const literalFilter = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "service", glob: "src/service.ts" }));
		expect(paths(literalFilter.details.matches)).toEqual(["src/service.ts"]);
	});

	it("glob 独立过滤文件和目录，且 root 与 scoped pattern 等价", async () => {
		await writeFixture("src/a.ts");
		await writeFixture("src/b.tsx");
		await writeFixture("src/deep/c.ts");
		await writeFixture("src/deep/d.js");
		await mkdir(path.join(workspace, "packages", "api"), { recursive: true });
		await mkdir(path.join(workspace, "packages", "web"), { recursive: true });
		await mkdir(path.join(workspace, "db", "migrations"), { recursive: true });

		const rootGlob = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "ts", glob: "src/**/*.ts" }));
		const scopedGlob = expectFindSuccess(await findWorkspaceFiles(workspace, { path: "src", query: "ts", glob: "**/*.ts" }));
		expect(paths(rootGlob.details.matches)).toEqual(paths(scopedGlob.details.matches));
		expect(paths(rootGlob.details.matches)).toEqual(["src/a.ts", "src/deep/c.ts"]);

		expect(paths(expectFindSuccess(await findWorkspaceFiles(workspace, { query: "packages", glob: "packages/*/" })).details.matches)).toEqual([
			"packages/api",
			"packages/web",
		]);
		expect(paths(expectFindSuccess(await findWorkspaceFiles(workspace, { query: "migrations", glob: "**/migrations" })).details.matches)).toEqual([
			"db/migrations",
		]);
	});

	it("glob 仅合入真实匹配的 repo-map 候选，并以直接结构证据共识重排和去重", async () => {
		const first = "export const FirstService = 1;\n";
		const preferred = "export const PreferredService = 1;\n";
		const wrongExtension = "export const WrongExtension = 1;\n";
		await writeFixture("src/a-service.ts");
		await writeFile(path.join(workspace, "src", "a-service.ts"), first);
		await writeFixture("src/z-service.ts");
		await writeFile(path.join(workspace, "src", "z-service.ts"), preferred);
		await writeFixture("src/z-service.js");
		await writeFile(path.join(workspace, "src", "z-service.js"), wrongExtension);
		const preferredCandidate = repoMapCandidate("src/z-service.ts", preferred, ["exact symbol", "definition"]);
		const query = vi.fn(async (input): Promise<RepoMapQueryResult> => ({
			root: workspace,
			explanation: { queryTerms: [input.query], expandedTerms: [input.query], seedCount: 1, maxHop: 2 },
			candidates: [
				preferredCandidate,
				{ ...preferredCandidate, reasons: ["public api"] },
				repoMapCandidate("src/a-service.ts", first, ["definition"], { confidence: 0.5, hop: 2 }),
				repoMapCandidate("src/z-service.js", wrongExtension, ["exact symbol"]),
			],
		}));

		const result = expectFindSuccess(await findWorkspaceFiles(
			workspace,
			{ query: "service", glob: "src/*-service.ts" },
			undefined,
			{ repoMap: repoMapQuery(query) },
		));

		expect(query).toHaveBeenCalledWith(expect.objectContaining({ query: "service", limit: expect.any(Number) }));
		expect(paths(result.details.matches)).toEqual(["src/z-service.ts", "src/a-service.ts"]);
		expect(result.details.matches.filter((match) => match.path === "src/z-service.ts")).toHaveLength(1);
		expect(paths(result.details.matches)).not.toContain("src/z-service.js");
		expect(result.details.related).toEqual([
			{
				path: "src/a-service.ts",
				kind: "file",
				source: "repo-map",
				relations: ["definition"],
				query_match: "not_guaranteed",
			},
			{
				path: "src/z-service.js",
				kind: "file",
				source: "repo-map",
				relations: ["symbol"],
				query_match: "not_guaranteed",
			},
		]);
		expect(result.content).toContain("<related repo-map nonmatch>");
		expect(result.content).toContain("src/z-service.js [symbol]");
	});

	it("主 glob 结果充足时不返回结构关联通道", async () => {
		for (const name of ["a", "b", "c", "d"]) await writeFixture(`src/${name}-service.ts`);
		const relatedText = "export const RelatedService = true;\n";
		await writeFile(path.join(workspace, "src", "related-service.js"), relatedText);
		const query = vi.fn(async (input): Promise<RepoMapQueryResult> => ({
			root: workspace,
			explanation: { queryTerms: [input.query], expandedTerms: [input.query], seedCount: 1, maxHop: 2 },
			candidates: [repoMapCandidate("src/related-service.js", relatedText, ["definition"])],
		}));

		const result = expectFindSuccess(await findWorkspaceFiles(
			workspace,
			{ query: "service", glob: "src/*-service.ts" },
			undefined,
			{ repoMap: repoMapQuery(query) },
		));

		expect(result.details.matches).toHaveLength(4);
		expect(result.details.related).toBeUndefined();
		expect(result.content).not.toContain("query match not guaranteed");
	});

	it("主 glob 结果为空时单独返回有界的 Repo Map 关联文件", async () => {
		const content = "export const ServiceFixture = true;\n";
		const lowConfidence = "export const LowConfidence = true;\n";
		await writeFixture("tests/service-fixture.ts");
		await writeFile(path.join(workspace, "tests", "service-fixture.ts"), content);
		await writeFile(path.join(workspace, "low-confidence.ts"), lowConfidence);
		const query = vi.fn(async (input): Promise<RepoMapQueryResult> => ({
			root: workspace,
			explanation: { queryTerms: [input.query], expandedTerms: [input.query], seedCount: 1, maxHop: 2 },
			candidates: [
				repoMapCandidate("tests/service-fixture.ts", content, ["test"]),
				repoMapCandidate("low-confidence.ts", lowConfidence, ["definition"], { confidence: 0.2 }),
			],
		}));

		const result = expectFindSuccess(await findWorkspaceFiles(
			workspace,
			{ query: "service", glob: "src/*-service.ts" },
			undefined,
			{ repoMap: repoMapQuery(query) },
		));

		expect(result.details.matches).toEqual([]);
		expect(result.details.missingPrefix).toBe("src");
		expect(result.details.related).toEqual([{
			path: "tests/service-fixture.ts",
			kind: "file",
			source: "repo-map",
			relations: ["test"],
			query_match: "not_guaranteed",
		}]);
		expect(result.content).toContain("none");
		expect(result.content).toContain("<related repo-map nonmatch>");
	});

	it("关联文件按导航价值排序并限制为三条", async () => {
		await mkdir(path.join(workspace, "src"));
		const fixtures = [
			{ path: "related-definition.ts", reason: "definition" as const },
			{ path: "related-alias.ts", reason: "alias" as const },
			{ path: "related-caller.ts", reason: "caller" as const },
			{ path: "related-test.ts", reason: "test" as const },
			{ path: "related-entrypoint.ts", reason: "entrypoint" as const },
		];
		for (const fixture of fixtures) await writeFile(path.join(workspace, fixture.path), `export const ${fixture.reason} = true;\n`);
		const query = vi.fn(async (input): Promise<RepoMapQueryResult> => ({
			root: workspace,
			explanation: { queryTerms: [input.query], expandedTerms: [input.query], seedCount: 1, maxHop: 2 },
			candidates: fixtures.map((fixture) => repoMapCandidate(
				fixture.path,
				`export const ${fixture.reason} = true;\n`,
				[fixture.reason],
			)),
		}));

		const result = expectFindSuccess(await findWorkspaceFiles(
			workspace,
			{ query: "service", glob: "src/*-service.ts" },
			undefined,
			{ repoMap: repoMapQuery(query) },
		));

		expect(result.details.related?.map((item) => item.relations[0])).toEqual(["definition", "alias", "caller"]);
		expect(result.details.related).toHaveLength(3);
		expect(countTextTokensSync(result.content).tokens).toBeLessThanOrEqual(600);
	});

	it("glob 在 repo-map 查询失效时保持原结果", async () => {
		await writeFixture("src/a-service.ts");
		await writeFixture("src/z-service.ts");
		const baseline = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "service", glob: "src/*-service.ts" }));
		const query = vi.fn(async () => { throw new Error("repo-map unavailable"); });
		const degraded = expectFindSuccess(await findWorkspaceFiles(
			workspace,
			{ query: "service", glob: "src/*-service.ts" },
			undefined,
			{ repoMap: repoMapQuery(query) },
		));

		expect(query).toHaveBeenCalledTimes(1);
		expect(degraded).toEqual(baseline);
	});

	it("repo-map 始终接收语义 query，而非从 glob 提取词", async () => {
		await writeFixture("src/a.ts");
		const query = vi.fn(async (): Promise<RepoMapQueryResult | undefined> => undefined);
		const result = expectFindSuccess(await findWorkspaceFiles(
			workspace,
			{ query: "a", glob: "**/*.ts" },
			undefined,
			{ repoMap: repoMapQuery(query) },
		));

		expect(paths(result.details.matches)).toEqual(["src/a.ts"]);
		expect(query).toHaveBeenCalledWith(expect.objectContaining({ query: "a" }));
	});

	it("按 basename、stem、segment、path fragment 和多词 token 定位路径", async () => {
		await writeFixture("src/file-tools/find-tool.ts");
		await writeFixture("src/file-tools/config.ts");
		await writeFixture("tests/websearch-renderer.test.ts");
		await mkdir(path.join(workspace, "src", "migrations"), { recursive: true });

		expect(paths(expectFindSuccess(await findWorkspaceFiles(workspace, { query: "config.ts" })).details.matches)[0]).toBe("src/file-tools/config.ts");
		expect(paths(expectFindSuccess(await findWorkspaceFiles(workspace, { query: "find-tool" })).details.matches)[0]).toBe("src/file-tools/find-tool.ts");
		expect(paths(expectFindSuccess(await findWorkspaceFiles(workspace, { query: "migrations" })).details.matches)[0]).toBe("src/migrations");
		expect(paths(expectFindSuccess(await findWorkspaceFiles(workspace, { query: "web search renderer test" })).details.matches)[0]).toBe(
			"tests/websearch-renderer.test.ts",
		);
		expect(paths(expectFindSuccess(await findWorkspaceFiles(workspace, { query: "file tools config" })).details.matches)[0]).toBe(
			"src/file-tools/config.ts",
		);
	});

	it("支持 camelCase、snake_case、kebab-case 和 smart case", async () => {
		await writeFixture("src/AuthService.test.ts");
		await writeFixture("src/auth_service.ts");
		await writeFixture("src/auth-service.ts");
		await writeFixture("src/authservice.ts");

		expect(paths(expectFindSuccess(await findWorkspaceFiles(workspace, { query: "auth service" })).details.matches).slice(0, 3)).toEqual([
			"src/auth-service.ts",
			"src/auth_service.ts",
			"src/authservice.ts",
		]);
		expect(paths(expectFindSuccess(await findWorkspaceFiles(workspace, { query: "AuthService" })).details.matches)[0]).toBe(
			"src/AuthService.test.ts",
		);
	});

	it("精确 basename 和目录 basename 排在 fuzzy 或普通 path substring 前面", async () => {
		await writeFixture("src/deep/permission-helper.ts");
		await writeFixture("docs/permission.md");
		await writeFixture("permission.ts");
		await mkdir(path.join(workspace, "src", "auth"), { recursive: true });
		await writeFixture("src/not-auth-service.ts");

		expect(paths(expectFindSuccess(await findWorkspaceFiles(workspace, { query: "permission.ts" })).details.matches)[0]).toBe("permission.ts");
		expect(paths(expectFindSuccess(await findWorkspaceFiles(workspace, { query: "auth" })).details.matches)[0]).toBe("src/auth");
	});

	it("多词查询严格阶段无结果后才放宽，并提供 typo 建议", async () => {
		await writeFixture("src/auth/service.ts");
		await writeFixture("src/auth/services.ts");
		await writeFixture("src/billing/service.ts");

		const strict = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "auth service" }));
		expect(paths(strict.details.matches).slice(0, 2)).toEqual(["src/auth/service.ts", "src/auth/services.ts"]);

		const typo = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "auth servce" }));
		expect(typo.content).toContain("<nearby nonmatch>");
		expect(typo.content).toContain("src/auth/service.ts [name similarity]");
		expect(paths(typo.details.nearby ?? [])).toContain("src/auth/service.ts");
	});

	it("主结果严格遵守 glob，零命中时可提示 glob 外的相关路径", async () => {
		await writeFixture("src/auth-service.js");
		await writeFixture("src/unrelated.ts");

		const result = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "auth service", glob: "src/**/*.ts" }));

		expect(result.details.matches).toEqual([]);
		expect(result.details.nearby).toEqual(expect.arrayContaining([
			expect.objectContaining({ path: "src/auth-service.js", kind: "file", reason: "outside glob" }),
		]));
		expect(result.content).toContain("src/auth-service.js [outside glob]");
		expect(result.content).not.toMatch(/^src\/auth-service\.js$/mu);
	});

	it("查询包含 test/spec/fixture/mock 时提升测试路径", async () => {
		await writeFixture("src/auth/service.ts");
		await writeFixture("tests/auth/service.test.ts");

		const result = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "auth service test" }));
		expect(paths(result.details.matches)[0]).toBe("tests/auth/service.test.ts");
	});

	it("未声明测试意图时实现文件排在同名测试文件前", async () => {
		await writeFixture("src/file-tools/ranking-evidence.ts");
		await writeFixture("tests/file-tools/ranking-evidence.test.ts");
		const query = vi.fn(async (input): Promise<RepoMapQueryResult> => ({
			root: workspace,
			explanation: { queryTerms: [input.query], expandedTerms: [input.query], seedCount: 1, maxHop: 2 },
			candidates: [repoMapCandidate("tests/file-tools/ranking-evidence.test.ts", "", ["definition"])],
		}));

		const result = expectFindSuccess(await findWorkspaceFiles(
			workspace,
			{ query: "ranking evidence" },
			undefined,
			{ repoMap: repoMapQuery(query) },
		));
		expect(paths(result.details.matches).slice(0, 2)).toEqual([
			"src/file-tools/ranking-evidence.ts",
			"tests/file-tools/ranking-evidence.test.ts",
		]);
	});

	it("排序稳定，renderer 的 Top matches 保留已选相关性顺序", async () => {
		for (const directory of ["a", "b", "c"]) {
			for (let index = 0; index < 30; index += 1) await writeFixture(`${directory}/file-${String(index).padStart(2, "0")}.ts`);
		}

		const first = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "file", glob: "**/*.ts" }));
		const second = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "file", glob: "**/*.ts" }));
		expect(first).toEqual(second);
		expect(first.details.totalMatches).toBe(90);
		expect(first.details.returnedMatches).toBe(50);
		expect(first.details).toMatchObject({ scanTruncated: false, resultLimited: true, outputTruncated: false });
		expect(first.content).toContain("top:");
		expect(first.content).toContain("other:");
		const topMatches = first.content.split("other:")[0] ?? "";
		expect(topMatches).toContain("a/");
		expect(topMatches).not.toContain("b/");
		expect(topMatches).not.toContain("c/");
		expect(topMatches.indexOf("a/file-00.ts")).toBeLessThan(topMatches.indexOf("a/file-01.ts"));
	});

	it("输出遵守 token budget，find_result_limit 和 find_max_entries_scanned 生效", async () => {
		const configPath = path.join(outside, "find-limits.jsonc");
		await writeFile(
			configPath,
			[
				"{",
				'  "ignore": { "builtin_profile": "none", "gitignore": false },',
				'  "limits": {',
				'    "find_output_token_budget": 32,',
				'    "find_result_limit": 3,',
				'    "find_max_entries_scanned": 5',
				"  }",
				"}",
			].join("\n"),
		);
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		for (let index = 0; index < 20; index += 1) await writeFixture(`many/file-${String(index).padStart(2, "0")}.ts`);

		const result = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "file", glob: "**/*.ts" }));
		expect(countTextTokensSync(result.content).tokens).toBeLessThanOrEqual(32);
		expect(result.details.returnedMatches).toBeLessThanOrEqual(3);
		expect(result.details.scannedEntries).toBe(5);
		expect(result.details.scanTruncated).toBe(true);
		expect(result.content.split("\n")[0]).toContain("truncated=scan");
	});

	it("遵守 .piignore 的 search、traverse、反向 include 和 prune 语义", async () => {
		await mkdir(path.join(workspace, "ignored"), { recursive: true });
		await mkdir(path.join(workspace, "pruned"), { recursive: true });
		await writeFile(path.join(workspace, ".piignore"), ["ignored/*", "!ignored/keep.ts", "pruned/"].join("\n"));
		await writeFile(path.join(workspace, "ignored", "drop.ts"), "");
		await writeFile(path.join(workspace, "ignored", "keep.ts"), "");
		await writeFile(path.join(workspace, "pruned", "hidden.ts"), "");

		const result = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "ts", glob: "**/*.ts" }));
		expect(paths(result.details.matches)).toEqual(["ignored/keep.ts"]);
		expect(result.details.ignoredCount).toBeGreaterThanOrEqual(2);
	});

	it("显式 find 允许命中 soft ignored 文件和目录内容", async () => {
		await mkdir(path.join(workspace, "ignored-dir"), { recursive: true });
		await writeFile(path.join(workspace, ".piignore"), "ignored.ts\nignored-dir/\n");
		await writeFile(path.join(workspace, "ignored.ts"), "");
		await writeFile(path.join(workspace, "ignored-dir", "secret.ts"), "");

		expect(paths(expectFindSuccess(await findWorkspaceFiles(workspace, { query: "ts", glob: "**/*.ts" })).details.matches)).toEqual([]);
		expect(paths(expectFindSuccess(await findWorkspaceFiles(workspace, { query: "ignored.ts" })).details.matches)).toEqual(["ignored.ts"]);
		expect(paths(expectFindSuccess(await findWorkspaceFiles(workspace, { path: "ignored-dir", query: "secret", glob: "**/*.ts" })).details.matches)).toEqual([
			"ignored-dir/secret.ts",
		]);
		expect(paths(expectFindSuccess(await findWorkspaceFiles(workspace, { query: "ignored-dir", glob: "ignored-dir/**/*.ts" })).details.matches)).toEqual([
			"ignored-dir/secret.ts",
		]);
	});

	it("blocked path 不出现在结果、统计或建议中，dotfile 正常参与搜索", async () => {
		await mkdir(path.join(workspace, ".github"), { recursive: true });
		await mkdir(path.join(workspace, ".git"), { recursive: true });
		await writeFile(path.join(workspace, ".env.example"), "");
		await writeFile(path.join(workspace, ".github", "workflow.yml"), "");
		await writeFile(path.join(workspace, ".git", "config"), "");

		const env = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "env", glob: "**/*" }));
		expect(paths(env.details.matches)).toContain(".env.example");
		const git = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "git", glob: "**/*" }));
		expect(paths(git.details.matches)).toContain(".github");
		expect(paths(git.details.matches)).not.toContain(".git/config");
		expect(git.details.scannedEntries).toBe(3);
		expect(await findWorkspaceFiles(workspace, { path: ".git", query: "file", glob: "**/*" })).toMatchObject({
			status: "failed",
			error: { code: "PROTECTED_PATH" },
		});
	});

	it("blocked_path 对 search root 的 realpath 生效", async () => {
		const protectedDir = path.join(outside, "protected");
		const configPath = path.join(outside, "blocked-realpath.jsonc");
		await mkdir(protectedDir);
		await writeFile(path.join(protectedDir, "secret.ts"), "");
		await writeFile(
			configPath,
			JSON.stringify({ blocked_path: [`${protectedDir}/`], ignore: { builtin_profile: "none", gitignore: false } }),
		);
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		try {
			await symlink(protectedDir, path.join(workspace, "protected-link"), "dir");
		} catch {
			return;
		}
		expect(await findWorkspaceFiles(workspace, { path: "protected-link", query: "ts", glob: "**/*.ts" })).toMatchObject({
			status: "failed",
			error: { code: "PROTECTED_PATH" },
		});
	});

	it("不返回文件 symlink，也不进入目录 symlink", async () => {
		await mkdir(path.join(workspace, "real-dir"));
		await writeFile(path.join(workspace, "real-dir", "real.ts"), "");
		await writeFile(path.join(workspace, "target.ts"), "");
		try {
			await symlink(path.join(workspace, "target.ts"), path.join(workspace, "link.ts"), "file");
			await symlink(path.join(workspace, "real-dir"), path.join(workspace, "link-dir"), "dir");
		} catch {
			return;
		}

		const result = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "ts", glob: "**/*.ts" }));
		expect(paths(result.details.matches)).toEqual(["target.ts", "real-dir/real.ts"]);
		expect(paths(result.details.matches)).not.toContain("link.ts");
		expect(paths(result.details.matches)).not.toContain("link-dir/real.ts");
		expect(expectFindSuccess(await findWorkspaceFiles(workspace, { query: "link-dir" })).details.totalMatches).toBe(0);
	});

	it("零结果、missing prefix nearby 和 AbortSignal", async () => {
		await mkdir(path.join(workspace, "src"));
		await writeFile(path.join(workspace, "src", "a.ts"), "");

		const none = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "no-such-file" }));
		expect(none.content).toBe("none\nsearched=2; ignored=0; skipped=0\nnext: broaden query or path");
		expect(none.details.nearby).toBeUndefined();

		const missing = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "ts", glob: "srcs/**/*.ts" }));
		expect(missing.content).toContain("missing prefix: srcs/");
		expect(missing.content).toContain("near dir: src/");

		const controller = new AbortController();
		controller.abort();
		expect(await findWorkspaceFiles(workspace, { query: "file", glob: "**/*" }, controller.signal)).toMatchObject({
			status: "failed",
			error: { code: "OPERATION_ABORTED" },
		});
	});
});
