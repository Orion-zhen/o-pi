import { fileURLToPath } from "node:url";
import { vi } from "vitest";

vi.mock("../../../src/harness/runtime/paths.ts", async (load) => {
	const paths = await load<typeof import("../../../src/harness/runtime/paths.ts")>();
	return { ...paths, defaultAgentConfigPath: (name: string) => name === "approval-gate.jsonc"
		? fileURLToPath(new URL("./policy-fixture.json", import.meta.url)) : paths.defaultAgentConfigPath(name) };
});
