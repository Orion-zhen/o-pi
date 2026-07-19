import { stat } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import repoMapExtension from "../../agent/extensions/repo-map.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-repo-extension-");
preserveEnv("PI_REPO_MAP_CACHE_DIR", "PI_REPO_MAP_CONFIG");

describe("Repo Map extension loading boundary", () => {
	it("registers only /init without creating or reading cache/config", async () => {
		const cacheRoot = path.join(temp.path, "cache");
		const configPath = path.join(temp.path, "does-not-exist.jsonc");
		process.env["PI_REPO_MAP_CACHE_DIR"] = cacheRoot;
		process.env["PI_REPO_MAP_CONFIG"] = configPath;
		const commands: string[] = [];
		repoMapExtension({
			on() {},
			registerCommand(name) { commands.push(name); },
			appendEntry() {},
		} satisfies Pick<ExtensionAPI, "registerCommand" | "appendEntry" | "on">);
		expect(commands).toEqual(["init"]);
		await expect(stat(cacheRoot)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
