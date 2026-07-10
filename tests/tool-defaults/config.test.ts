import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { findNearestProjectRoot, isToolEnabledByDefault, loadToolDefaultsConfig } from "../../src/tool-defaults/config.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

let workspace: string;
const temp = useTempDir("o-pi-tool-defaults-");
preserveEnv("PI_TOOLS_CONFIG", "PI_TOOLS_PROJECT_CONFIG", "PI_TOOLS_PROJECT_ROOT");

beforeEach(() => {
	workspace = temp.path;
	process.env.PI_TOOLS_CONFIG = path.join(workspace, "missing-user.jsonc");
	delete process.env.PI_TOOLS_PROJECT_CONFIG;
	delete process.env.PI_TOOLS_PROJECT_ROOT;
});

describe("tool defaults config", () => {
	it("缺少配置时所有工具默认启用", async () => {
		const config = await loadToolDefaultsConfig(workspace);
		expect(config).toEqual({ tools: {} });
		expect(isToolEnabledByDefault(config, "bash")).toBe(true);
	});

	it("用户配置与项目配置合并，项目配置按工具覆盖用户配置", async () => {
		const userPath = path.join(workspace, "user.jsonc");
		process.env.PI_TOOLS_CONFIG = userPath;
		await writeFile(
			userPath,
			`{
				"$schema": "tools.schema.json",
				"bash": false,
				"read": true,
				"grep": false,
			}`,
		);

		const projectRoot = path.join(workspace, "repo");
		await mkdir(path.join(projectRoot, ".pi"), { recursive: true });
		await writeFile(
			path.join(projectRoot, ".pi", "tools.jsonc"),
			`{
				"bash": true,
				"write": false,
			}`,
		);

		const config = await loadToolDefaultsConfig(path.join(projectRoot, "src"));

		expect(config.tools).toEqual({ bash: true, read: true, grep: false, write: false });
		expect(isToolEnabledByDefault(config, "edit")).toBe(true);
	});

	it("拒绝非对象配置和非 boolean 工具值", async () => {
		const userPath = path.join(workspace, "bad.jsonc");
		process.env.PI_TOOLS_CONFIG = userPath;

		await writeFile(userPath, "[]");
		await expect(loadToolDefaultsConfig(workspace)).rejects.toThrow("must be an object");

		await writeFile(userPath, '{ "bash": "off" }');
		await expect(loadToolDefaultsConfig(workspace)).rejects.toThrow("values must be boolean");
	});

	it("从当前目录向上查找最近的 .pi 项目根", async () => {
		const projectRoot = path.join(workspace, "repo");
		const child = path.join(projectRoot, "packages", "demo");
		await mkdir(path.join(projectRoot, ".pi"), { recursive: true });
		await mkdir(child, { recursive: true });

		expect(findNearestProjectRoot(child)).toBe(projectRoot);
	});
});
