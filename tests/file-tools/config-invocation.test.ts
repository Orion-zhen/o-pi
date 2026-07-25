import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { clearFileToolsConfigCache } from "../../src/file-tools/config.js";
import { editWorkspace } from "../../src/file-tools/tools/edit.js";
import { findWorkspaceFiles } from "../../src/file-tools/tools/find.js";
import { grepWorkspaceFiles } from "../../src/file-tools/tools/grep.js";
import { listWorkspaceDirectory } from "../../src/file-tools/tools/ls.js";
import { readWorkspaceFile } from "../../src/file-tools/tools/read.js";
import { writeWorkspaceFile } from "../../src/file-tools/tools/write.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

const workspaceTemp = useTempDir("o-pi-file-tools-invocation-config-");
const userConfigTemp = useTempDir("o-pi-file-tools-user-config-");
preserveEnv("PI_FILE_TOOLS_CONFIG", "PI_FILE_TOOLS_PROJECT_CONFIG", "PI_FILE_TOOLS_PROJECT_ROOT");

beforeEach(async () => {
	delete process.env.PI_FILE_TOOLS_PROJECT_CONFIG;
	delete process.env.PI_FILE_TOOLS_PROJECT_ROOT;
	const userConfig = path.join(userConfigTemp.path, "file-tools.jsonc");
	await writeFile(userConfig, "{}\n");
	process.env.PI_FILE_TOOLS_CONFIG = userConfig;
	clearFileToolsConfigCache();
});

describe("invocation cwd project config", () => {
	it("六个工具都按 invocation cwd 加载项目配置并在 workspace I/O 前返回 CONFIG_ERROR", async () => {
		const workspace = workspaceTemp.path;
		await mkdir(path.join(workspace, ".pi", "configs"), { recursive: true });
		await writeFile(
			path.join(workspace, ".pi", "configs", "file-tools.jsonc"),
			JSON.stringify({ limits: { ls_entries: 0 } }),
		);

		const outcomes = await Promise.all([
			listWorkspaceDirectory(workspace, {}),
			readWorkspaceFile(workspace, { path: "missing.txt" }),
			writeWorkspaceFile(workspace, { path: "new.txt", content: "new\n" }),
			editWorkspace(workspace, { path: "missing.txt", edits: [{ old: "old", new: "new" }] }),
			findWorkspaceFiles(workspace, { query: "anything" }),
			grepWorkspaceFiles(workspace, { query: "anything" }),
		]);

		for (const outcome of outcomes) {
			expect(outcome).toMatchObject({ status: "failed", error: { code: "CONFIG_ERROR" } });
		}
		await expect(readFile(path.join(workspace, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
	});
});
