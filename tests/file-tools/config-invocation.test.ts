import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { editFile } from "../../src/file-tools/edit/command.js";
import { piTextDiffGenerator } from "../../src/file-tools/pi/ports/text-diff.js";
import { findWorkspaceFiles } from "../helpers/find-tool.js";
import { grepWorkspaceFiles } from "../helpers/grep-tool.js";
import { listDirectory } from "../../src/file-tools/ls/command.js";
import { FileToolsHost } from "../../src/file-tools/runtime/host.js";
import { isFailed } from "../../src/file-tools/shared/result.js";
import { readWorkspaceFile } from "../helpers/read-tool.js";
import { writeFile as writeFileCommand } from "../../src/file-tools/write/command.js";
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
});

async function runMutation(cwd: string, kind: "write" | "edit") {
	const host = new FileToolsHost();
	try {
		const opened = await host.open({ cwd, sessionId: "config-invocation" });
		if (isFailed(opened)) return opened;
		try {
			return kind === "write"
				? await writeFileCommand({ path: "new.txt", content: "new\n" }, {
					filesystem: opened.filesystem,
					operation: opened.context,
					maxFileBytes: opened.limits.write_max_file_bytes,
					diff: piTextDiffGenerator,
				})
				: await editFile({ path: "missing.txt", edits: [{ old: "old", new: "new" }] }, {
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
	} finally {
		host.dispose();
	}
}

async function listWorkspaceDirectory(cwd: string) {
	const host = new FileToolsHost();
	try {
		const opened = await host.open({ cwd, sessionId: "config-invocation" });
		if (isFailed(opened)) return opened;
		try {
			return await listDirectory({}, {
				filesystem: opened.filesystem,
				operation: opened.context,
				entryLimit: opened.limits.ls_entries,
			});
		} finally {
			opened.dispose();
		}
	} finally {
		host.dispose();
	}
}

describe("invocation cwd project config", () => {
	it("六个工具都按 invocation cwd 加载项目配置并在 workspace I/O 前返回 CONFIG_ERROR", async () => {
		const workspace = workspaceTemp.path;
		await mkdir(path.join(workspace, ".pi", "configs"), { recursive: true });
		await writeFile(
			path.join(workspace, ".pi", "configs", "file-tools.jsonc"),
			JSON.stringify({ limits: { ls_entries: 0 } }),
		);

		const outcomes = await Promise.all([
			listWorkspaceDirectory(workspace),
			readWorkspaceFile(workspace, { path: "missing.txt" }),
			runMutation(workspace, "write"),
			runMutation(workspace, "edit"),
			findWorkspaceFiles(workspace, { query: "anything" }),
			grepWorkspaceFiles(workspace, { query: "anything" }),
		]);

		for (const outcome of outcomes) {
			expect(outcome).toMatchObject({ status: "failed", error: { code: "CONFIG_ERROR" } });
		}
		await expect(readFile(path.join(workspace, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
	});
});
