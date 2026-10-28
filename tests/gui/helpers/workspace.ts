import { test as base } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type Workspace = { home: string; cwd: string; agentDir: string; env: Record<string, string> };
export const test = base.extend<{ workspace: Workspace }>({
	workspace: async ({}, use) => {
		const home = await mkdtemp(path.join(os.tmpdir(), "opi-gui-e2e-"));
		const cwd = path.join(home, "workspace");
		const agentDir = path.join(home, ".pi", "agent");
		try {
			await mkdir(cwd);
			await mkdir(path.join(agentDir, "configs"), { recursive: true });
			await writeFile(path.join(agentDir, "settings.json"), '{"defaultProjectTrust":"never"}');
			await writeFile(path.join(agentDir, "configs", "discord-presence.jsonc"), '{"enabled":false}');
			const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
				entry[1] !== undefined && /^(PATH|DISPLAY|XAUTHORITY|LD_LIBRARY_PATH|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|SYSTEMROOT|WINDIR|TEMP|TMP)$/.test(entry[0])));
			Object.assign(env, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", OPI_NO_NOTIFICATIONS: "1", NODE_ENV: "test", XDG_CONFIG_HOME: path.join(home, "config") });
			await use({ home, cwd, agentDir, env });
		} finally { await rm(home, { recursive: true, force: true }); }
	},
});
export { expect } from "@playwright/test";
