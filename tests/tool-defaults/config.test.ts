import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findNearestProjectRoot, isToolEnabledByDefault, loadToolDefaultsConfig } from "../../src/tool-defaults/config.js";

let workspace: string;
let previousUserConfig: string | undefined;
let previousProjectConfig: string | undefined;
let previousProjectRoot: string | undefined;

beforeEach(async () => {
	workspace = await mkdtemp(path.join(os.tmpdir(), "o-pi-tool-defaults-"));
	previousUserConfig = process.env.PI_TOOLS_CONFIG;
	previousProjectConfig = process.env.PI_TOOLS_PROJECT_CONFIG;
	previousProjectRoot = process.env.PI_TOOLS_PROJECT_ROOT;
	process.env.PI_TOOLS_CONFIG = path.join(workspace, "missing-user.jsonc");
	delete process.env.PI_TOOLS_PROJECT_CONFIG;
	delete process.env.PI_TOOLS_PROJECT_ROOT;
});

afterEach(async () => {
	if (previousUserConfig === undefined) delete process.env.PI_TOOLS_CONFIG;
	else process.env.PI_TOOLS_CONFIG = previousUserConfig;
	if (previousProjectConfig === undefined) delete process.env.PI_TOOLS_PROJECT_CONFIG;
	else process.env.PI_TOOLS_PROJECT_CONFIG = previousProjectConfig;
	if (previousProjectRoot === undefined) delete process.env.PI_TOOLS_PROJECT_ROOT;
	else process.env.PI_TOOLS_PROJECT_ROOT = previousProjectRoot;
	await rm(workspace, { recursive: true, force: true });
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
