import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { beforeEach } from "vitest";
import { SKILL_CONTEXT_ENTRY } from "../../../src/harness/skill-context/types.ts";
import shellTools from "../../../src/harness/extensions/shell-tools.ts";
import type { ShellName } from "../../../src/harness/shell-runtime/platform.ts";
import { registerExtension } from "../../helpers/extension.ts";
import { preserveEnv, useTempDir } from "../../helpers/lifecycle.ts";
import { executeShellCommand } from "../../../src/harness/shell-tools/execute.ts";
import type { ShellLimits, ShellToolsConfig } from "../../../src/harness/shell-runtime/config.ts";
import type { ExecuteShellRuntime } from "../../../src/harness/shell-tools/types.ts";

export function useShellWorkspace(prefix: string) {
	const temp = useTempDir(prefix);
	preserveEnv("TMPDIR", "TMP", "TEMP");
	beforeEach(() => { process.env.TMPDIR = process.env.TMP = process.env.TEMP = temp.path; });
	return temp;
}

export function registeredShellTool(name: ShellName) {
	const tool = registerExtension(shellTools).registered.find((tool) => tool.name === name);
	if (!tool) throw new Error(`未注册 ${name}`);
	return tool;
}

export function loadedSkill(root: string): SessionEntry[] {
	return [{ type: "custom", id: "load", parentId: null, timestamp: "t", customType: SKILL_CONTEXT_ENTRY,
		data: { name: "demo", path: path.join(root, "SKILL.md"), root, contentHash: "hash", scope: "project", loadedBy: "manual", loadedAt: "t" } }];
}

export function runBash({ command, timeout = 300 }: { command: string; timeout?: number },
	{ cwd, sessionId, limits, ...runtime }: ExecuteShellRuntime & { cwd: string; sessionId: string; limits: ShellLimits }) {
	return executeShellCommand({ kind: "resolved", command, timeout, cwd, sessionId, limits, env: process.env }, runtime);
}

export function bashToolConfig(): ShellToolsConfig {
	return {
		default_timeout_seconds: 300,
		python_venv_paths: [".venv", "venv", "env", ".env", "pyvenv", "pyenv", ".pyvenv", ".pyenv"],
		environment: { inherit: true, remove_name_regex: [], expose_pi_session_file: true },
		limits: {
			success_output_bytes: 24_576,
			failure_output_bytes: 49_152,
			live_output_bytes: 8_192,
			max_capture_bytes: 268_435_456,
		},
	};
}
