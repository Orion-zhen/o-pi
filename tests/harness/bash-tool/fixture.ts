import { executeBashCommand } from "../../../src/harness/bash-tool/bash-tool.ts";
import type { BashLimits, BashToolConfig } from "../../../src/harness/bash-runtime/config.ts";
import type { ExecuteBashRuntime } from "../../../src/harness/bash-tool/types.ts";

export function runBash({ command, timeout = 300 }: { command: string; timeout?: number },
	{ cwd, sessionId, limits, ...runtime }: ExecuteBashRuntime & { cwd: string; sessionId: string; limits: BashLimits }) {
	return executeBashCommand({ kind: "resolved", command, timeout, cwd, sessionId, limits, env: process.env }, runtime);
}

export function bashToolConfig(): BashToolConfig {
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
