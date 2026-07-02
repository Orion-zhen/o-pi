import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editWorkspace } from "../src/file-tools/edit-tool.js";
import { createIgnoreSnapshot, defaultIgnoreEngine } from "../src/file-tools/ignore/ignore-engine.js";
import { listWorkspaceDirectory } from "../src/file-tools/ls-tool.js";
import { readWorkspaceFile } from "../src/file-tools/read-tool.js";

const execFileAsync = promisify(execFile);

let workspace: string;
let outside: string;

beforeEach(async () => {
	workspace = await mkdtemp(path.join(os.tmpdir(), "o-pi-ignore-"));
	outside = await mkdtemp(path.join(os.tmpdir(), "o-pi-ignore-outside-"));
	defaultIgnoreEngine.invalidate();
});

afterEach(async () => {
	await rm(workspace, { recursive: true, force: true });
	await rm(outside, { recursive: true, force: true });
	defaultIgnoreEngine.invalidate();
});

describe("ignore engine", () => {
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

		expect(snapshot.evaluate({ path: "#literal", kind: "file", intent: "search" }).ignored).toBe(true);
		expect(snapshot.evaluate({ path: "!bang", kind: "file", intent: "search" }).ignored).toBe(true);
		expect(snapshot.evaluate({ path: "a.log", kind: "file", intent: "search" }).ignored).toBe(true);
		expect(snapshot.evaluate({ path: "q1.txt", kind: "file", intent: "search" }).ignored).toBe(true);
		expect(snapshot.evaluate({ path: "a.js", kind: "file", intent: "search" }).ignored).toBe(true);
		expect(snapshot.evaluate({ path: "docs/a/b.md", kind: "file", intent: "search" }).ignored).toBe(true);
		expect(snapshot.evaluate({ path: "root-only.txt", kind: "file", intent: "search" }).ignored).toBe(true);
		expect(snapshot.evaluate({ path: "nested/root-only.txt", kind: "file", intent: "search" }).ignored).toBe(false);
		expect(snapshot.evaluate({ path: "src/inner.txt", kind: "file", intent: "search" }).ignored).toBe(true);
		expect(snapshot.evaluate({ path: "build", kind: "directory", intent: "traverse" }).ignored).toBe(true);
		expect(snapshot.evaluate({ path: "build", kind: "file", intent: "search" }).ignored).toBe(false);
		expect(snapshot.evaluate({ path: "trail-space", kind: "file", intent: "search" }).ignored).toBe(true);
		expect(snapshot.evaluate({ path: "escaped-space ", kind: "file", intent: "search" }).ignored).toBe(true);
		expect(snapshot.evaluate({ path: ".env", kind: "file", intent: "search" }).ignored).toBe(true);
		expect(snapshot.evaluate({ path: "nonewline", kind: "file", intent: "search" }).ignored).toBe(true);
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

	it("Git tracked 文件绕过 .gitignore，但不绕过 .piignore", async () => {
		if (!(await hasGit())) return;
		await execFileAsync("git", ["init"], { cwd: workspace });
		await writeFile(path.join(workspace, ".gitignore"), "*.json\n");
		await writeFile(path.join(workspace, "tracked.json"), "{}\n");
		await writeFile(path.join(workspace, "untracked.json"), "{}\n");
		await execFileAsync("git", ["add", "-f", "tracked.json"], { cwd: workspace });

		let snapshot = await createIgnoreSnapshot(workspace, { builtinProfile: "none", caseSensitivity: "sensitive" });
		expect(snapshot.evaluate({ path: "tracked.json", kind: "file", intent: "search" }).ignored).toBe(false);
		expect(snapshot.evaluate({ path: "untracked.json", kind: "file", intent: "search" }).ignored).toBe(true);

		await writeFile(path.join(workspace, ".piignore"), "tracked.json\n");
		snapshot = await createIgnoreSnapshot(workspace, { builtinProfile: "none", caseSensitivity: "sensitive" });
		expect(snapshot.evaluate({ path: "tracked.json", kind: "file", intent: "search" }).ignored).toBe(true);
	});

	it("snapshot 不可变，新 snapshot 才看到 ignore 文件变化，并支持缓存复用", async () => {
		await writeFile(path.join(workspace, ".piignore"), "old.txt\n");
		const first = await createIgnoreSnapshot(workspace, { builtinProfile: "none", gitignore: { enabled: false } });
		const cached = await createIgnoreSnapshot(workspace, { builtinProfile: "none", gitignore: { enabled: false } });
		expect(cached.generation).toBe(first.generation);
		expect(first.evaluate({ path: "old.txt", kind: "file", intent: "search" }).ignored).toBe(true);

		await new Promise((resolve) => setTimeout(resolve, 10));
		await writeFile(path.join(workspace, ".piignore"), "new.txt\n");
		const second = await createIgnoreSnapshot(workspace, { builtinProfile: "none", gitignore: { enabled: false } });
		expect(second.generation).not.toBe(first.generation);
		expect(first.evaluate({ path: "new.txt", kind: "file", intent: "search" }).ignored).toBe(false);
		expect(second.evaluate({ path: "new.txt", kind: "file", intent: "search" }).ignored).toBe(true);
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

	it("工具集成：ls 标记 ignored，read 允许读取，edit 不因 soft ignore 拒绝", async () => {
		await mkdir(path.join(workspace, "dist"));
		await writeFile(path.join(workspace, ".piignore"), "dist/\n");
		await writeFile(path.join(workspace, "dist", "schema.json"), "{\"a\":1}\n");

		expect(await listWorkspaceDirectory(workspace, { path: "." })).toMatchObject({
			entries: [
				{ name: "dist", path: "dist", type: "directory", ignored: true, ignore_source: ".piignore" },
				{ name: ".piignore", path: ".piignore", type: "file" },
			],
		});
		const read = await readWorkspaceFile(workspace, { path: "dist/schema.json" });
		expect(read).toMatchObject({ content: "{\"a\":1}\n", ignored: true, ignore_source: ".piignore" });
		if (!("version" in read)) throw new Error("read failed");
		expect(
			await editWorkspace(workspace, {
				operations: [
					{
						type: "replace_file",
						path: "dist/schema.json",
						base_version: read.version,
						content: "{\"a\":2}\n",
					},
				],
			}),
		).toMatchObject({ status: "applied" });
		expect(await readFile(path.join(workspace, "dist", "schema.json"), "utf8")).toBe("{\"a\":2}\n");

		await mkdir(path.join(workspace, ".git"));
		expect(await listWorkspaceDirectory(workspace, { path: "." })).toMatchObject({ blocked_entries: 1 });
		expect(await readWorkspaceFile(workspace, { path: ".git/config" })).toMatchObject({
			status: "failed",
			error: { code: "PERMISSION_DENIED" },
		});
	});

	it("成功 edit 修改 .piignore 后，后续工具调用使用新规则", async () => {
		await writeFile(path.join(workspace, ".piignore"), "old.txt\n");
		await writeFile(path.join(workspace, "old.txt"), "old\n");
		await writeFile(path.join(workspace, "new.txt"), "new\n");
		const before = await readWorkspaceFile(workspace, { path: ".piignore" });
		if (!("version" in before)) throw new Error("read failed");
		await editWorkspace(workspace, {
			operations: [{ type: "replace_file", path: ".piignore", base_version: before.version, content: "new.txt\n" }],
		});
		const listed = await listWorkspaceDirectory(workspace, { path: "." });
		expect(listed).toMatchObject({
			entries: [{ name: ".piignore" }, { name: "new.txt", ignored: true }, { name: "old.txt" }],
		});
		if ("status" in listed) throw new Error("ls failed");
		expect(listed.entries.find((entry) => entry.name === ".piignore")).not.toHaveProperty("ignored");
		expect(listed.entries.find((entry) => entry.name === "old.txt")).not.toHaveProperty("ignored");
	});

	it("可选 Git 差分：基础 .gitignore 结果与 git check-ignore 一致", async () => {
		if (!(await hasGit())) return;
		await execFileAsync("git", ["init"], { cwd: workspace });
		await mkdir(path.join(workspace, "src"));
		await mkdir(path.join(workspace, "build"));
		await writeFile(path.join(workspace, ".gitignore"), "*.log\nbuild/\n!important.log\n");
		await writeFile(path.join(workspace, "src", ".gitignore"), "local.tmp\n");
		await writeFile(path.join(workspace, "debug.log"), "");
		await writeFile(path.join(workspace, "important.log"), "");
		await writeFile(path.join(workspace, "src", "local.tmp"), "");
		await writeFile(path.join(workspace, "src", "keep.tmp"), "");

		const snapshot = await createIgnoreSnapshot(workspace, {
			builtinProfile: "none",
			piignore: { enabled: false },
			gitignore: { trackedFilesBypass: false },
			caseSensitivity: "sensitive",
		});
		for (const candidate of ["debug.log", "build/", "important.log", "src/local.tmp", "src/keep.tmp"]) {
			const engineIgnored = snapshot.evaluate({
				path: candidate.replace(/\/$/, ""),
				kind: candidate.endsWith("/") ? "directory" : "file",
				intent: "search",
			}).ignored;
			expect(engineIgnored).toBe(await gitCheckIgnore(candidate));
		}
	});
});

async function hasGit(): Promise<boolean> {
	try {
		await execFileAsync("git", ["--version"]);
		return true;
	} catch {
		return false;
	}
}

async function gitCheckIgnore(candidate: string): Promise<boolean> {
	try {
		await execFileAsync("git", ["check-ignore", "-q", candidate], { cwd: workspace });
		return true;
	} catch {
		return false;
	}
}
