import type { BashToolConfig } from "../../src/bash-tool/types.js";

export function bashToolConfig(): BashToolConfig {
	return {
		default_timeout_seconds: 300,
		python_venv_paths: [".venv", "venv", "env", ".env", "pyvenv", "pyenv", ".pyvenv", ".pyenv"],
		limits: {
			success_output_bytes: 24_576,
			failure_output_bytes: 49_152,
			live_output_bytes: 8_192,
			max_capture_bytes: 268_435_456,
		},
		safety: { deny_patterns: [], deny_regex: [] },
	};
}
