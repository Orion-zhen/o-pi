import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { editFile } from "../../src/file-tools/edit/command.js";
import type { EditParams, EditSuccess } from "../../src/file-tools/edit/types.js";
import { listDirectory } from "../../src/file-tools/ls/command.js";
import type { LsParams, LsSuccess } from "../../src/file-tools/ls/types.js";
import { piTextDiffGenerator } from "../../src/file-tools/pi/ports/text-diff.js";
import { FileToolsHost } from "../../src/file-tools/runtime/host.js";
import { isFailed, type ToolOutcome } from "../../src/file-tools/shared/result.js";
import { useTempDir } from "../helpers/lifecycle.js";
import { readWorkspaceFile as readWorkspaceFileTest } from "../helpers/read-tool.js";

let workspace: string;
let host: FileToolsHost;
const workspaceTemp = useTempDir("o-pi-visibility-integration-");

beforeEach(() => {
	workspace = workspaceTemp.path;
	host = new FileToolsHost();
});

afterEach(() => {
	host.dispose();
});

async function listWorkspaceDirectory(cwd: string, params: LsParams): Promise<ToolOutcome<LsSuccess>> {
	const opened = await host.open({ cwd, sessionId: "visibility-test" });
	if (isFailed(opened)) return opened;
	try {
		return await listDirectory(params, {
			filesystem: opened.filesystem,
			operation: opened.context,
			entryLimit: opened.limits.ls_entries,
		});
	} finally {
		opened.dispose();
	}
}

function readWorkspaceFile(cwd: string, params: Parameters<typeof readWorkspaceFileTest>[1]) {
	return readWorkspaceFileTest(cwd, params, { host, sessionId: "visibility-test" });
}

async function editWorkspace(cwd: string, params: EditParams): Promise<ToolOutcome<EditSuccess>> {
	const opened = await host.open({ cwd, sessionId: "visibility-test" });
	if (isFailed(opened)) return opened;
	try {
		return await editFile(params, {
			filesystem: opened.filesystem,
			operation: opened.context,
			observation: opened.observation,
			maxFileBytes: opened.limits.edit_max_file_bytes,
			matchHintLimit: opened.limits.edit_match_hint_limit,
			diff: piTextDiffGenerator,
		});
	} finally {
		opened.dispose();
	}
}

describe("visibility tool integration", () => {
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
		expect(await listWorkspaceDirectory(workspace, { path: "dist" })).toMatchObject({
			path: "dist",
			entries: [{ name: "schema.json", path: "dist/schema.json", type: "file", ignored: true, ignore_source: ".piignore" }],
		});
		const read = await readWorkspaceFile(workspace, { path: "dist/schema.json" });
		expect(read).toMatchObject({ content: "{\"a\":1}\n", ignored: true, ignore_source: ".piignore" });
		if (!("version" in read)) throw new Error("read failed");
		expect(
			await editWorkspace(workspace, {
				path: "dist/schema.json",
				edits: [{ old: "{\"a\":1}", new: "{\"a\":2}" }],
			}),
		).toMatchObject({ status: "applied" });
		expect(await readFile(path.join(workspace, "dist", "schema.json"), "utf8")).toBe("{\"a\":2}\n");

		await mkdir(path.join(workspace, ".git"));
		await writeFile(path.join(workspace, ".git", "config"), "[core]\n");
		const withGit = await listWorkspaceDirectory(workspace, { path: "." });
		if ("status" in withGit) throw new Error("ls failed");
		expect(withGit.entries.find((entry) => entry.name === ".git")).toBeUndefined();
		expect(await readWorkspaceFile(workspace, { path: ".git/config" })).toMatchObject({
			status: "failed",
			error: { code: "PROTECTED_PATH" },
		});
	});

	it("工具集成：可见目录中的嵌套规则按枚举路径增量加载", async () => {
		await mkdir(path.join(workspace, "packages"), { recursive: true });
		for (let index = 0; index < 10; index += 1) {
			const directory = path.join(workspace, "packages", `pkg-${index}`);
			await mkdir(directory);
			await writeFile(path.join(directory, ".piignore"), "generated.txt\n");
			await writeFile(path.join(directory, "generated.txt"), "generated\n");
		}

		const root = await listWorkspaceDirectory(workspace, { path: "." });
		if ("status" in root) throw new Error("root listing failed");
		expect(root.entries.find((entry) => entry.name === "packages")).not.toHaveProperty("ignored");
		const nested = await listWorkspaceDirectory(workspace, { path: "packages/pkg-9" });
		if ("status" in nested) throw new Error("nested listing failed");
		expect(nested.entries.find((entry) => entry.name === "generated.txt")).toMatchObject({
			ignored: true,
			ignore_source: ".piignore",
		});
	});

	it("成功 edit 修改 .piignore 后，后续工具调用使用新规则", async () => {
		await writeFile(path.join(workspace, ".piignore"), "old.txt\n");
		await writeFile(path.join(workspace, "old.txt"), "old\n");
		await writeFile(path.join(workspace, "new.txt"), "new\n");
		const before = await readWorkspaceFile(workspace, { path: ".piignore" });
		if (!("version" in before)) throw new Error("read failed");
		await editWorkspace(workspace, {
			path: ".piignore",
			edits: [{ old: "old.txt", new: "new.txt" }],
		});
		const listed = await listWorkspaceDirectory(workspace, { path: "." });
		expect(listed).toMatchObject({
			entries: [{ name: ".piignore" }, { name: "new.txt", ignored: true }, { name: "old.txt" }],
		});
		if ("status" in listed) throw new Error("ls failed");
		expect(listed.entries.find((entry) => entry.name === ".piignore")).not.toHaveProperty("ignored");
		expect(listed.entries.find((entry) => entry.name === "old.txt")).not.toHaveProperty("ignored");
	});
});
