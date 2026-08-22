import { execFile } from "node:child_process";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";

import type { ExistingRef } from "../../src/filesystem/contracts/path.js";
import type {
	PartialIgnoreConfig,
	VisibilityAnnotation,
	VisibilityIntent,
} from "../../src/filesystem/contracts/visibility.js";
import {
	NativeFileSystemError,
	NodeNativeFileSystem,
} from "../../src/filesystem/platform/node/native-filesystem.js";
import { createVisibilityPolicy } from "../../src/filesystem/services/visibility/policy.js";
import { useTempDir } from "../helpers/lifecycle.js";
import {
	expectFsOk,
	openReadonly,
	overrideNativeFileSystem,
	type OpenedReadonly,
} from "./fixtures.js";
import { hasGit } from "./visibility-fixtures.js";

const execFileAsync = promisify(execFile);
const workspaceTemp = useTempDir("o-pi-ignore-");
const outsideTemp = useTempDir("o-pi-ignore-outside-");
let workspace: string;
let outside: string;

beforeEach(() => {
	workspace = workspaceTemp.path;
	outside = outsideTemp.path;
});

async function openVisibility(
	ignore: PartialIgnoreConfig = {},
	ignoredPaths: readonly string[] = [],
): Promise<OpenedReadonly> {
	return await openReadonly(workspace, {
		policy: createVisibilityPolicy({ ignore, ignoredPaths }),
	});
}

async function resolve(opened: OpenedReadonly, input: string): Promise<ExistingRef> {
	return expectFsOk(await opened.namespace.paths.resolveExisting(
		input,
		{ expected: "any", followFinalSymlink: true },
	));
}

async function evaluate(
	opened: OpenedReadonly,
	input: string,
	intent: VisibilityIntent = "search",
): Promise<VisibilityAnnotation> {
	return expectFsOk(await opened.services.visibility.evaluate(await resolve(opened, input), intent));
}

async function write(relativePath: string, content = "\n"): Promise<void> {
	const absolutePath = path.join(workspace, relativePath);
	await mkdir(path.dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, content);
}

describe("visibility rules", () => {
	it("通过增量 operations 支持 Gitignore grammar 基础规则", async () => {
		await write(".piignore", [
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
		].join("\n"));
		for (const candidate of [
			"#literal", "!bang", "a.log", "q1.txt", "a.js", "docs/a/b.md", "root-only.txt",
			"src/inner.txt", "trail-space", "escaped-space ", ".env", "nonewline", "nested/root-only.txt",
		]) await write(candidate);
		await mkdir(path.join(workspace, "build"));

		const opened = await openVisibility({
			builtinProfile: "none",
			gitignore: { enabled: false },
		});
		for (const candidate of [
			"#literal", "!bang", "a.log", "q1.txt", "a.js", "docs/a/b.md", "root-only.txt",
			"src/inner.txt", "trail-space", "escaped-space ", ".env", "nonewline",
		]) expect(await evaluate(opened, candidate)).toMatchObject({ ignored: true });
		expect(await evaluate(opened, "nested/root-only.txt")).toMatchObject({ ignored: false });
		expect(await evaluate(opened, "build", "traverse")).toMatchObject({ ignored: true });
	});

	it("按可达来源、目录层级和后置规则决定优先级", async () => {
		await write(".gitignore", "dist/\n*.txt\nnode_modules/\n");
		await write(".piignore", "!dist/\n!important.txt\n!node_modules/\n");
		await write("sub/.piignore", "important.txt\n");
		await mkdir(path.join(workspace, "dist"));
		await mkdir(path.join(workspace, "node_modules"));
		await write("important.txt");
		await write("sub/important.txt");

		const opened = await openVisibility({ builtinProfile: "minimal" });
		expect(await evaluate(opened, "dist", "traverse")).toMatchObject({ ignored: false });
		expect(await evaluate(opened, "important.txt")).toMatchObject({ ignored: false });
		expect(await evaluate(opened, "sub/important.txt")).toMatchObject({ ignored: true });
		expect(await evaluate(opened, "node_modules", "traverse")).toMatchObject({ ignored: false });
	});

	it("区分 ignored 与 prune，并保守处理根规则 negation", async () => {
		await write(".piignore", "cache/\n!cache/keep.txt\nlogs/\n");
		await mkdir(path.join(workspace, "cache"));
		await mkdir(path.join(workspace, "logs"));
		const opened = await openVisibility({
			builtinProfile: "none",
			gitignore: { enabled: false },
		});
		expect(await evaluate(opened, "cache", "traverse")).toMatchObject({ ignored: true, prune: false });
		expect(await evaluate(opened, "logs", "traverse")).toMatchObject({ ignored: true, prune: false });

		await write(".piignore", "logs/\n");
		const withoutNegation = await openVisibility({
			builtinProfile: "none",
			gitignore: { enabled: false },
		});
		expect(await evaluate(withoutNegation, "logs", "traverse")).toMatchObject({ ignored: true, prune: true });
	});

	it("增量加载嵌套 .gitignore 和 .piignore，规则相对于所在目录", async () => {
		await write(".gitignore", "*.tmp\n");
		await write("pkg/.gitignore", "!keep.tmp\nlocal.log\n");
		await write(".piignore", "root-only/\n");
		await write("pkg/deep/.piignore", "generated/\n");
		for (const candidate of ["pkg/drop.tmp", "pkg/keep.tmp", "pkg/local.log"]) await write(candidate);
		await mkdir(path.join(workspace, "root-only"));
		await mkdir(path.join(workspace, "pkg", "deep", "generated"));
		await mkdir(path.join(workspace, "generated"));
		const opened = await openVisibility({ builtinProfile: "none" });

		expect(await evaluate(opened, "pkg/drop.tmp")).toMatchObject({ ignored: true });
		expect(await evaluate(opened, "pkg/keep.tmp")).toMatchObject({ ignored: false });
		expect(await evaluate(opened, "pkg/local.log")).toMatchObject({ ignored: true });
		expect(await evaluate(opened, "root-only", "traverse")).toMatchObject({ ignored: true });
		expect(await evaluate(opened, "pkg/deep/generated", "traverse")).toMatchObject({ ignored: true });
		expect(await evaluate(opened, "generated", "traverse")).toMatchObject({ ignored: false });
	});

	it("仅在访问目录链时加载宽目录树中的嵌套规则", async () => {
		for (let index = 0; index < 40; index += 1) {
			await write(`pkg-${index}/.gitignore`, "hidden.txt\n");
			await write(`pkg-${index}/hidden.txt`);
		}
		const opened = await openVisibility({
			builtinProfile: "none",
			piignore: { enabled: false },
		});
		expect(await evaluate(opened, "pkg-39/hidden.txt")).toMatchObject({ ignored: true });
	});

	it("Git core.ignoreCase 优先于平台默认", async () => {
		if (!(await hasGit())) return;
		await execFileAsync("git", ["init"], { cwd: workspace });
		await write(".gitignore", "mixed.txt\n");
		await write("MIXED.TXT");
		await execFileAsync("git", ["config", "core.ignoreCase", "true"], { cwd: workspace });
		const insensitive = await openVisibility({ builtinProfile: "none" });
		expect(await evaluate(insensitive, "MIXED.TXT")).toMatchObject({ ignored: true });

		await execFileAsync("git", ["config", "core.ignoreCase", "false"], { cwd: workspace });
		const sensitive = await openVisibility({ builtinProfile: "none" });
		expect(await evaluate(sensitive, "MIXED.TXT")).toMatchObject({ ignored: false });
	});

	it("Git tracked 文件绕过 .gitignore，但不绕过 .piignore", async () => {
		if (!(await hasGit())) return;
		await execFileAsync("git", ["init"], { cwd: workspace });
		await write(".gitignore", "*.json\n");
		await write("tracked.json", "{}\n");
		await write("untracked.json", "{}\n");
		const beforeTracking = await openVisibility({ builtinProfile: "none" });
		expect(await evaluate(beforeTracking, "tracked.json")).toMatchObject({ ignored: true });
		await execFileAsync("git", ["add", "-f", "tracked.json"], { cwd: workspace });

		const tracked = await openVisibility({ builtinProfile: "none" });
		expect(tracked.services.visibility.fingerprint)
			.not.toBe(beforeTracking.services.visibility.fingerprint);
		expect(await evaluate(tracked, "tracked.json")).toMatchObject({ ignored: false });
		expect(await evaluate(tracked, "untracked.json")).toMatchObject({ ignored: true });

		await write(".piignore", "tracked.json\n");
		const withPiignore = await openVisibility({ builtinProfile: "none" });
		expect(await evaluate(withPiignore, "tracked.json")).toMatchObject({ ignored: true });
	});

	it("统一相对、目录和外部绝对 configured path 规则", async () => {
		await write("nested/secret.txt");
		await write("nested/cache/item.txt");
		const external = path.join(outside, "secret.txt");
		await writeFile(external, "secret\n");
		const opened = await openVisibility(
			{ builtinProfile: "none", gitignore: { enabled: false }, piignore: { enabled: false } },
			["secret.txt", "cache/", external],
		);
		expect(await evaluate(opened, "nested/secret.txt", "explicit-read")).toMatchObject({
			ignored: true,
			source: "file-tools.jsonc",
			rule: "secret.txt",
		});
		expect(await evaluate(opened, "nested/cache/item.txt", "explicit-read")).toMatchObject({ ignored: true });
		const externalOnly = await openVisibility(
			{ builtinProfile: "none", gitignore: { enabled: false }, piignore: { enabled: false } },
			[external],
		);
		expect(await evaluate(externalOnly, external, "explicit-read")).toMatchObject({ ignored: true, rule: external });
	});

	it("symlink 按逻辑名称匹配，ignore 文件 symlink 不被读取", async () => {
		const externalIgnore = path.join(outside, "ignore");
		await writeFile(externalIgnore, "secret.txt\n");
		await write("secret.txt");
		try {
			await symlink(externalIgnore, path.join(workspace, ".piignore"));
		} catch {
			return;
		}
		const withoutRules = await openVisibility({ builtinProfile: "none", gitignore: { enabled: false } });
		expect(await evaluate(withoutRules, "secret.txt")).toMatchObject({ ignored: false });

		await rm(path.join(workspace, ".piignore"), { force: true });
		await write(".piignore", "link-dir\n");
		await mkdir(path.join(outside, "link-target"));
		await symlink(path.join(outside, "link-target"), path.join(workspace, "link-dir"));
		const withRules = await openVisibility({ builtinProfile: "none", gitignore: { enabled: false } });
		expect(await evaluate(withRules, "link-dir", "list-entry")).toMatchObject({ ignored: true });
	});

	it("非 UTF-8 ignore 文件 fail-open", async () => {
		await write(".gitignore", "valid.txt\n");
		await write("valid.txt");
		await write("from-piignore.txt");
		await writeFile(path.join(workspace, ".piignore"), Buffer.from([0xc3, 0x28]));
		const opened = await openVisibility({ builtinProfile: "none" });
		expect(await evaluate(opened, "valid.txt")).toMatchObject({ ignored: true });
		expect(await evaluate(opened, "from-piignore.txt")).toMatchObject({ ignored: false });
	});

	it("ignore 文件读取失败时 fail-open，取消仍终止操作", async () => {
		await write(".piignore", "hidden.txt\n");
		await write("hidden.txt");
		const ignorePath = path.join(workspace, ".piignore");
		const base = new NodeNativeFileSystem();
		const denied = await openReadonly(workspace, {
			native: overrideNativeFileSystem({
				async read(pathname, context) {
					if (pathname === ignorePath) throw new NativeFileSystemError("access-denied", "read", pathname);
					return await base.read(pathname, context);
				},
			}, base),
			policy: createVisibilityPolicy({ ignore: { builtinProfile: "none", gitignore: { enabled: false } } }),
		});
		expect(await evaluate(denied, "hidden.txt")).toMatchObject({ ignored: false });

		const canceled = await openReadonly(workspace, {
			native: overrideNativeFileSystem({
				async read(pathname, context) {
					if (pathname === ignorePath) throw new NativeFileSystemError("aborted", "read", pathname);
					return await base.read(pathname, context);
				},
			}, base),
			policy: createVisibilityPolicy({ ignore: { builtinProfile: "none", gitignore: { enabled: false } } }),
		});
		expect(await canceled.services.visibility.evaluate(await resolve(canceled, "hidden.txt"), "search"))
			.toMatchObject({ ok: false, error: { code: "aborted" } });
	});

	it("已剪枝目录不会为嵌套 ignore 文件扫描子树", async () => {
		await write(".piignore", "ignored/\n");
		await write("ignored/.piignore", "!keep.txt\n");
		await write("ignored/keep.txt");
		const base = new NodeNativeFileSystem();
		const ignoreReads: string[] = [];
		const opened = await openReadonly(workspace, {
			native: overrideNativeFileSystem({
				async read(pathname, context) {
					if (path.basename(pathname) === ".piignore") ignoreReads.push(pathname);
					return await base.read(pathname, context);
				},
			}, base),
			policy: createVisibilityPolicy({ ignore: { builtinProfile: "none", gitignore: { enabled: false } } }),
		});

		expect(await evaluate(opened, "ignored", "traverse")).toMatchObject({ ignored: true, prune: true });
		expect(ignoreReads).toEqual([path.join(workspace, ".piignore")]);
	});
});
