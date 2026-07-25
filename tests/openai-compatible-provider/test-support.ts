import { afterEach, beforeEach, vi } from "vitest";

import { preserveEnv, setTestHome, useTempDir, type TempDir } from "../helpers/lifecycle.js";

/** 为 provider 测试统一隔离 HOME、配置目录和 Vitest 全局 mock。 */
export function useOpenAICompatibleProviderTestSetup(): TempDir {
	const temp = useTempDir("o-pi-models-jsonc-");
	preserveEnv("PI_CODING_AGENT_DIR");
	preserveEnv("PI_OFFLINE");
	preserveEnv("HOME", "USERPROFILE");

	beforeEach(() => {
		setTestHome(temp.path);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	return temp;
}
