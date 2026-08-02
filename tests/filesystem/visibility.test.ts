import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
	PartialIgnoreConfig,
	VisibilityEvaluateInput,
	VisibilitySnapshot,
} from "../../src/filesystem/contracts/visibility.js";
import { createVisibilityPolicy } from "../../src/filesystem/services/visibility/policy.js";
import { createVisibilitySnapshot, defaultVisibilityService as defaultIgnoreEngine } from "../../src/filesystem/services/visibility/service.js";
import { useTempDir } from "../helpers/lifecycle.js";
import { hasGit } from "./visibility-fixtures.js";

const execFileAsync = promisify(execFile);

let workspace: string;
let outside: string;
const workspaceTemp = useTempDir("o-pi-ignore-");
const outsideTemp = useTempDir("o-pi-ignore-outside-");

beforeEach(() => {
	workspace = workspaceTemp.path;
	outside = outsideTemp.path;
	defaultIgnoreEngine.invalidate();
});

afterEach(() => {
	defaultIgnoreEngine.invalidate();
});

async function createIgnoreSnapshot(root: string, ignore: PartialIgnoreConfig = {}): Promise<VisibilitySnapshot> {
	return await createVisibilitySnapshot(root, createVisibilityPolicy({ ignore }));
}

interface ConfiguredPathCase {
	readonly label: string;
	readonly rule: (workspace: string, outside: string) => string;
	readonly input: (workspace: string, outside: string) => VisibilityEvaluateInput;
}

const configuredPathCases: readonly ConfiguredPathCase[] = [
	{
		label: "相对文件",
		rule: () => "secret.txt",
		input: (root) => ({
			path: "nested/secret.txt",
			absolutePath: path.join(root, "nested", "secret.txt"),
			workspacePath: "nested/secret.txt",
			kind: "file",
			intent: "explicit-read",
		}),
	},
	{
		label: "相对目录",
		rule: () => "cache/",
		input: (root) => ({
			path: "nested/cache/item.txt",
			absolutePath: path.join(root, "nested", "cache", "item.txt"),
			workspacePath: "nested/cache/item.txt",
			kind: "file",
			intent: "explicit-read",
		}),
	},
	{
		label: "绝对路径",
		rule: (_root, external) => path.join(external, "secret.txt"),
		input: (_root, external) => ({
			path: path.join(external, "secret.txt"),
			absolutePath: path.join(external, "secret.txt"),
			kind: "file",
			intent: "explicit-read",
		}),
	},
	{
		label: "home 目录",
		rule: () => "~/.o-pi-f07/",
		input: () => {
			const absolutePath = path.join(os.homedir(), ".o-pi-f07", "secret.txt");
			return { path: absolutePath, absolutePath, kind: "file", intent: "explicit-read" };
		},
	},
];

describe("visibility rules", () => {
	it("支持 Gitignore grammar 的基础规则", async () => {
		await writeFile(
			path.join(workspace, ".piignore"),
			[
				"\uFEFF",
				"# comment",
				"\\#literal",
				"\\!bang",
				"*.log",
				"q?.txt",
				"[ab].js",
				"docs/**",
				"/root-only.txt",
				"src/inner.txt",
				"build/",
				"trail-space ",
				"escaped-space\\ ",
				".env",
				"nonewline",
			].join("\n"),
		);
		const snapshot = await createIgnoreSnapshot(workspace, {
			builtinProfile: "none",
			gitignore: { enabled: false },
			caseSensitivity: "sensitive",
		});

		for (const candidate of [
			"#literal", "!bang", "a.log", "q1.txt", "a.js", "docs/a/b.md", "root-only.txt",
			"src/inner.txt", "trail-space", "escaped-space ", ".env", "nonewline",
		]) {
			expect(snapshot.evaluate({ path: candidate, kind: "file", intent: "search" }).ignored).toBe(true);
		}
		expect(snapshot.evaluate({ path: "nested/root-only.txt", kind: "file", intent: "search" }).ignored).toBe(false);
		expect(snapshot.evaluate({ path: "build", kind: "directory", intent: "traverse" }).ignored).toBe(true);
		expect(snapshot.evaluate({ path: "build", kind: "file", intent: "search" }).ignored).toBe(false);
	});

	it("按来源、目录层级和后置规则决定优先级", async () => {
		await mkdir(path.join(workspace, "sub"));
		await writeFile(path.join(workspace, ".gitignore"), "dist/\n*.txt\nnode_modules/\n");
		await writeFile(path.join(workspace, ".piignore"), "!dist/\n!important.txt\n!node_modules/\n");
		await writeFile(path.join(workspace, "sub", ".piignore"), "important.txt\n");

		const sessionSnapshot = await createIgnoreSnapshot(workspace, {
			builtinProfile: "minimal",
			caseSensitivity: "sensitive",
			sessionRules: [{ action: "ignore", pattern: "dist/" }],
		});
		expect(sessionSnapshot.evaluate({ path: "dist", kind: "directory", intent: "traverse" }).ignored).toBe(true);

		const snapshot = await createIgnoreSnapshot(workspace, { builtinProfile: "minimal", caseSensitivity: "sensitive" });
		expect(snapshot.evaluate({ path: "dist", kind: "directory", intent: "traverse" }).state).toBe("include");
		expect(snapshot.evaluate({ path: "important.txt", kind: "file", intent: "search" }).state).toBe("include");
		expect(snapshot.evaluate({ path: "sub/important.txt", kind: "file", intent: "search" }).ignored).toBe(true);
		expect(snapshot.evaluate({ path: "node_modules", kind: "directory", intent: "traverse" }).state).toBe("include");
	});

	it("区分 ignored 与 prune，并保守处理可能重新包含的目录", async () => {
		await writeFile(path.join(workspace, ".piignore"), "cache/\n!cache/keep.txt\nlogs/\n");
		const snapshot = await createIgnoreSnapshot(workspace, {
			builtinProfile: "none",
			gitignore: { enabled: false },
			caseSensitivity: "sensitive",
		});
		expect(snapshot.evaluate({ path: "cache", kind: "directory", intent: "traverse" })).toMatchObject({
			state: "ignore",
			ignored: true,
			prune: false,
		});
		expect(snapshot.evaluate({ path: "cache/keep.txt", kind: "file", intent: "search" }).ignored).toBe(true);
		expect(snapshot.evaluate({ path: "logs", kind: "directory", intent: "traverse" })).toMatchObject({
			ignored: true,
			prune: false,
		});

		const noNegationRoot = await mkdtemp(path.join(os.tmpdir(), "o-pi-prune-"));
		try {
			await writeFile(path.join(noNegationRoot, ".piignore"), "logs/\n");
			const noNegation = await createIgnoreSnapshot(noNegationRoot, {
				builtinProfile: "none",
				gitignore: { enabled: false },
				caseSensitivity: "sensitive",
			});
			expect(noNegation.evaluate({ path: "logs", kind: "directory", intent: "traverse" }).prune).toBe(true);
		} finally {
			await rm(noNegationRoot, { recursive: true, force: true });
		}
	});

	it("支持嵌套 .gitignore 和 .piignore，规则相对于所在目录", async () => {
		await mkdir(path.join(workspace, "pkg", "deep"), { recursive: true });
		await writeFile(path.join(workspace, ".gitignore"), "*.tmp\n");
		await writeFile(path.join(workspace, "pkg", ".gitignore"), "!keep.tmp\nlocal.log\n");
		await writeFile(path.join(workspace, ".piignore"), "root-only/\n");
		await writeFile(path.join(workspace, "pkg", "deep", ".piignore"), "generated/\n");
		const snapshot = await createIgnoreSnapshot(workspace, { builtinProfile: "none", caseSensitivity: "sensitive" });
		expect(snapshot.evaluate({ path: "pkg/drop.tmp", kind: "file", intent: "search" }).ignored).toBe(true);
		expect(snapshot.evaluate({ path: "pkg/keep.tmp", kind: "file", intent: "search" }).state).toBe("include");
		expect(snapshot.evaluate({ path: "pkg/local.log", kind: "file", intent: "search" }).ignored).toBe(true);
		expect(snapshot.evaluate({ path: "root-only", kind: "directory", intent: "traverse" }).ignored).toBe(true);
		expect(snapshot.evaluate({ path: "pkg/deep/generated", kind: "directory", intent: "traverse" }).ignored).toBe(true);
		expect(snapshot.evaluate({ path: "generated", kind: "directory", intent: "traverse" }).ignored).toBe(false);
	});

	it("宽目录树跨 BFS 批次发现嵌套规则", async () => {
		for (let index = 0; index < 40; index += 1) {
			const directory = path.join(workspace, `pkg-${index}`);
			await mkdir(directory);
			await writeFile(path.join(directory, ".gitignore"), "hidden.txt\n");
		}
		const snapshot = await createIgnoreSnapshot(workspace, {
			builtinProfile: "none",
			piignore: { enabled: false },
			caseSensitivity: "sensitive",
		});
		const hiddenPath = path.join(workspace, "pkg-39", "hidden.txt");
		expect(snapshot.evaluate({
			path: "pkg-39/hidden.txt",
			absolutePath: hiddenPath,
			workspacePath: "pkg-39/hidden.txt",
			kind: "file",
			intent: "search",
		}).ignored).toBe(true);
	});

	it("Git tracked 文件绕过 .gitignore，但不绕过 .piignore", async () => {
		if (!(await hasGit())) return;
		await execFileAsync("git", ["init"], { cwd: workspace });
		await writeFile(path.join(workspace, ".gitignore"), "*.json\n");
		await writeFile(path.join(workspace, "tracked.json"), "{}\n");
		await writeFile(path.join(workspace, "untracked.json"), "{}\n");
		const beforeTracking = await createIgnoreSnapshot(workspace, { builtinProfile: "none", caseSensitivity: "sensitive" });
		expect(beforeTracking.evaluate({ path: "tracked.json", kind: "file", intent: "search" }).ignored).toBe(true);
		await execFileAsync("git", ["add", "-f", "tracked.json"], { cwd: workspace });

		let snapshot = await createIgnoreSnapshot(workspace, { builtinProfile: "none", caseSensitivity: "sensitive" });
		expect(snapshot.fingerprint).not.toBe(beforeTracking.fingerprint);
		expect(snapshot.evaluate({ path: "tracked.json", kind: "file", intent: "search" }).ignored).toBe(false);
		expect(snapshot.evaluate({ path: "untracked.json", kind: "file", intent: "search" }).ignored).toBe(true);

		await writeFile(path.join(workspace, ".piignore"), "tracked.json\n");
		snapshot = await createIgnoreSnapshot(workspace, { builtinProfile: "none", caseSensitivity: "sensitive" });
		expect(snapshot.evaluate({ path: "tracked.json", kind: "file", intent: "search" }).ignored).toBe(true);
	});
	it.each(configuredPathCases)("预编译并匹配 $label configured path rule", async ({ rule, input }) => {
		const configuredRule = rule(workspace, outside);
		const snapshot = await createVisibilitySnapshot(workspace, createVisibilityPolicy({
			ignoredPaths: [configuredRule],
			ignore: { builtinProfile: "none", gitignore: { enabled: false }, piignore: { enabled: false } },
		}));

		expect(snapshot.evaluate(input(workspace, outside))).toMatchObject({
			ignored: true,
			matchedRule: { sourceType: "config", pattern: configuredRule },
		});
	});

	it("统一 config ignored_path、来源与 intent prune 语义", async () => {
		const snapshot = await createVisibilitySnapshot(workspace, createVisibilityPolicy({
			ignoredPaths: ["cache/", path.join(outside, "secret.txt")],
			ignore: { builtinProfile: "none", gitignore: { enabled: false }, piignore: { enabled: false } },
		}));
		const search = snapshot.evaluate({
			path: "cache",
			absolutePath: path.join(workspace, "cache"),
			workspacePath: "cache",
			kind: "directory",
			intent: "search",
		});
		const explicit = snapshot.evaluate({
			path: "cache",
			absolutePath: path.join(workspace, "cache"),
			workspacePath: "cache",
			kind: "directory",
			intent: "explicit-read",
		});
		const outsideDecision = snapshot.evaluate({
			path: path.join(outside, "secret.txt"),
			absolutePath: path.join(outside, "secret.txt"),
			kind: "file",
			intent: "explicit-read",
		});

		expect(search).toMatchObject({ ignored: true, prune: true, matchedRule: { sourceType: "config", sourcePath: "file-tools.jsonc" } });
		expect(explicit).toMatchObject({ ignored: true, prune: false });
		expect(outsideDecision).toMatchObject({ ignored: true, matchedRule: { sourceType: "config" } });
	});

	it("explain 返回 trace、winner、来源文件和行号", async () => {
		await writeFile(path.join(workspace, ".piignore"), "*.log\n!important.log\n");
		const snapshot = await createIgnoreSnapshot(workspace, {
			builtinProfile: "none",
			gitignore: { enabled: false },
			caseSensitivity: "sensitive",
		});
		expect(snapshot.explain({ path: "important.log", kind: "file" })).toMatchObject({
			path: "important.log",
			ignored: false,
			trace: [
				{ sourceType: "piignore", sourcePath: ".piignore", line: 2, pattern: "!important.log", result: "include" },
			],
			winner: { sourceType: "piignore", sourcePath: ".piignore", line: 2, pattern: "!important.log" },
		});
		expect(snapshot.explain({ path: "other.ts", kind: "file" })).toMatchObject({
			path: "other.ts",
			ignored: false,
			trace: [],
		});
	});

	it("symlink 按逻辑名称匹配，ignore 文件 symlink 不被读取", async () => {
		await writeFile(path.join(outside, "ignore"), "secret.txt\n");
		try {
			await symlink(path.join(outside, "ignore"), path.join(workspace, ".piignore"));
		} catch {
			return;
		}
		const snapshot = await createIgnoreSnapshot(workspace, { builtinProfile: "none", gitignore: { enabled: false } });
		expect(snapshot.evaluate({ path: "secret.txt", kind: "file", intent: "search" }).ignored).toBe(false);

		await rm(path.join(workspace, ".piignore"), { force: true });
		await writeFile(path.join(workspace, ".piignore"), "link-dir\n");
		expect((await createIgnoreSnapshot(workspace, { builtinProfile: "none", gitignore: { enabled: false } })).evaluate({
			path: "link-dir",
			kind: "symlink",
			intent: "list-entry",
		}).ignored).toBe(true);
	});

	it("非 UTF-8 ignore 文件 fail-open 并返回结构化诊断", async () => {
		await writeFile(path.join(workspace, ".gitignore"), "valid.txt\n");
		await writeFile(path.join(workspace, ".piignore"), Buffer.from([0xc3, 0x28]));
		const snapshot = await createIgnoreSnapshot(workspace, { builtinProfile: "none", caseSensitivity: "sensitive" });
		expect(snapshot.evaluate({ path: "valid.txt", kind: "file", intent: "search" })).toMatchObject({
			ignored: true,
			diagnostics: [{ sourcePath: ".piignore", code: "UNSUPPORTED_IGNORE_ENCODING" }],
		});
		expect(snapshot.evaluate({ path: "from-piignore.txt", kind: "file", intent: "search" }).ignored).toBe(false);
		expect(snapshot.explain({ path: "from-piignore.txt", kind: "file" })).toMatchObject({
			diagnostics: [{ sourcePath: ".piignore", code: "UNSUPPORTED_IGNORE_ENCODING" }],
		});
	});
});
