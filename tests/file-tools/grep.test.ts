import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearGrepIndexForTests } from "../../src/file-tools/grep/indexer.js";
import { countTextTokensSync } from "../../src/token-counter.js";
import { formatCompactGrepResult, grepWorkspaceFiles } from "../../src/file-tools/tools/grep.js";
import type { GrepSuccess, ToolOutcome } from "../../src/file-tools/types.js";
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
	clearGrepIndexForTests();
});

afterEach(async () => {
	clearGrepIndexForTests();
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

describe("grep", () => {
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

	it("多文件结果保持多样性，测试文件默认降权但 test 查询取消降权", async () => {
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
		clearGrepIndexForTests();
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
		expect(zero.near_symbols).toContain("alphaSearch");
		const controller = new AbortController();
		controller.abort();
		expect(await grepWorkspaceFiles(workspace, { query: "Search" }, controller.signal)).toMatchObject({ status: "failed", error: { code: "OPERATION_ABORTED" } });
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
