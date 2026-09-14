import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";

import { editFile, previewEdit } from "../../../src/harness/file-tools/edit/command.js";
import type { MutationDiagnosticsSource } from "../../../src/harness/file-tools/shared/mutation-diagnostics.js";
import type { EditParams, EditSuccess } from "../../../src/harness/file-tools/edit/types.js";
import { piTextDiffGenerator } from "../../../src/harness/file-tools/pi/ports/text-diff.js";
import { FileToolsHost, type FileToolsInvocation } from "../../../src/harness/file-tools/runtime/host.js";
import type { ToolOutcome } from "../../../src/harness/file-tools/shared/result.js";
import type { TextDiffGenerator } from "../../../src/harness/file-tools/shared/text-diff.js";
import { writeFile as writeFileCommand } from "../../../src/harness/file-tools/write/command.js";
import type { WriteParams, WriteSuccess } from "../../../src/harness/file-tools/write/types.js";
import { preserveEnv, useTempDir } from "../../helpers/lifecycle.js";
import { readWorkspaceFile, type ReadWorkspaceTestOptions } from "../../helpers/read-tool.js";

export interface CrudTestContext {
	readonly workspace: string;
	readonly outside: string;
	read(params: Parameters<typeof readWorkspaceFile>[1], options?: ReadWorkspaceTestOptions): ReturnType<typeof readWorkspaceFile>;
	write(params: WriteParams, diff?: TextDiffGenerator): Promise<ToolOutcome<WriteSuccess>>;
	edit(params: EditParams, runtime?: { signal?: AbortSignal; diagnostics?: MutationDiagnosticsSource; diff?: TextDiffGenerator }): Promise<ToolOutcome<EditSuccess>>;
	preview(params: EditParams): ReturnType<typeof previewEdit>;
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
					...opened,
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
					...opened,
					diff: runtime.diff ?? piTextDiffGenerator,
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
					...opened,
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
