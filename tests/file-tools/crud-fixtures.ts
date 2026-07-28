import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";

import { editFile, previewEdit } from "../../src/file-tools/edit/command.js";
import type { EditDiagnosticsSource } from "../../src/file-tools/edit/ports.js";
import type { EditSuccess } from "../../src/file-tools/edit/types.js";
import { piTextDiffGenerator } from "../../src/file-tools/pi/ports/text-diff.js";
import { FileToolsHost, type FileToolsInvocation } from "../../src/file-tools/runtime/host.js";
import type { ToolOutcome } from "../../src/file-tools/shared/result.js";
import type { TextDiffGenerator } from "../../src/file-tools/shared/text-diff.js";
import { writeFile as writeFileCommand } from "../../src/file-tools/write/command.js";
import type { WriteSuccess } from "../../src/file-tools/write/types.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";
import { readWorkspaceFile, type ReadWorkspaceTestOptions } from "../helpers/read-tool.js";

export interface CrudTestContext {
	readonly workspace: string;
	readonly outside: string;
	read(params: Parameters<typeof readWorkspaceFile>[1], options?: ReadWorkspaceTestOptions): ReturnType<typeof readWorkspaceFile>;
	write(params: unknown, diff?: TextDiffGenerator): Promise<ToolOutcome<WriteSuccess>>;
	edit(params: unknown, runtime?: { signal?: AbortSignal; diagnostics?: EditDiagnosticsSource }): Promise<ToolOutcome<EditSuccess>>;
	preview(params: unknown): ReturnType<typeof previewEdit>;
	useConfig(config: Record<string, unknown>): Promise<void>;
}

export function createCrudTestContext(): CrudTestContext {
	const workspaceTemp = useTempDir("o-pi-crud-workspace-");
	const outsideTemp = useTempDir("o-pi-crud-outside-");
	preserveEnv("PI_FILE_TOOLS_CONFIG");
	let host: FileToolsHost;

	beforeEach(() => {
		host = new FileToolsHost();
	});
	afterEach(() => host.dispose());

	async function open(signal?: AbortSignal): Promise<ToolOutcome<FileToolsInvocation>> {
		return await host.open({ cwd: workspaceTemp.path, sessionId: "crud", ...(signal === undefined ? {} : { signal }) });
	}

	return {
		get workspace() { return workspaceTemp.path; },
		get outside() { return outsideTemp.path; },
		read(params, options = {}) {
			return readWorkspaceFile(workspaceTemp.path, params, { ...options, host, sessionId: "crud" });
		},
		async write(params, diff = piTextDiffGenerator) {
			const opened = await open();
			if ("status" in opened) return opened;
			try {
				return await writeFileCommand(params, {
					filesystem: opened.filesystem,
					operation: opened.context,
					maxFileBytes: opened.limits.write_max_file_bytes,
					diff,
				});
			} finally {
				opened.dispose();
			}
		},
		async edit(params, runtime = {}) {
			const opened = await open(runtime.signal);
			if ("status" in opened) return opened;
			try {
				return await editFile(params, {
					filesystem: opened.filesystem,
					operation: opened.context,
					observation: opened.observation,
					maxFileBytes: opened.limits.edit_max_file_bytes,
					matchHintLimit: opened.limits.edit_match_hint_limit,
					diff: piTextDiffGenerator,
					...(runtime.diagnostics === undefined ? {} : { diagnostics: runtime.diagnostics }),
				});
			} finally {
				opened.dispose();
			}
		},
		async preview(params) {
			const opened = await open();
			if ("status" in opened) return opened;
			try {
				return await previewEdit(params, {
					filesystem: opened.filesystem,
					operation: opened.context,
					maxFileBytes: opened.limits.edit_max_file_bytes,
					matchHintLimit: opened.limits.edit_match_hint_limit,
					diff: piTextDiffGenerator,
				});
			} finally {
				opened.dispose();
			}
		},
		async useConfig(config) {
			const configPath = path.join(outsideTemp.path, `file-tools-${Date.now()}-${Math.random()}.jsonc`);
			await writeFile(configPath, JSON.stringify(config, null, 2));
			process.env.PI_FILE_TOOLS_CONFIG = configPath;
		},
	};
}
