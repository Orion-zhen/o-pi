import { writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
	CONFIG_DEFINITIONS,
	createCompleteSchemaValidator,
	defaultAgentConfigPath,
	loadConfigLayers,
	mergeConfigValues,
	resolveConfigLayerPaths,
	type ConfigDefinition,
} from "../../src/config-loader.js";
import { preserveEnv, setTestHome, useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-config-loader-");
preserveEnv(
	"HOME",
	"USERPROFILE",
	"PI_APPROVAL_GATE_CONFIG",
	"PI_FILE_TOOLS_CONFIG",
	"PI_FILE_TOOLS_PROJECT_CONFIG",
	"PI_FILE_TOOLS_PROJECT_ROOT",
);

beforeEach(() => {
	setTestHome(temp.path);
	delete process.env.PI_APPROVAL_GATE_CONFIG;
	delete process.env.PI_FILE_TOOLS_CONFIG;
	delete process.env.PI_FILE_TOOLS_PROJECT_CONFIG;
	delete process.env.PI_FILE_TOOLS_PROJECT_ROOT;
});

describe("layered config loader", () => {
	it("集中声明只允许全局配置和允许项目配置的模块", () => {
		const projectEnabled = Object.entries(CONFIG_DEFINITIONS)
			.filter(([, definition]) => definition.project !== undefined)
			.map(([name]) => name);
		expect(projectEnabled).toEqual(["fileTools", "lsp", "subagent"]);
	});

	it("按默认、用户、项目顺序解析路径，环境变量只重定向对应层", () => {
		const user = path.join(temp.path, "user.jsonc");
		const project = path.join(temp.path, "project.jsonc");
		process.env.PI_FILE_TOOLS_CONFIG = user;
		process.env.PI_FILE_TOOLS_PROJECT_CONFIG = project;

		expect(resolveConfigLayerPaths(CONFIG_DEFINITIONS.fileTools, temp.path)).toEqual([
			{ kind: "default", path: defaultAgentConfigPath("file-tools.jsonc"), required: true },
			{ kind: "user", path: user, required: false },
			{ kind: "project", path: project, required: false },
		]);
	});

	it("全局专用配置永远不解析项目层", () => {
		expect(resolveConfigLayerPaths(CONFIG_DEFINITIONS.approvalGate, temp.path).map((source) => source.kind)).toEqual([
			"default",
			"user",
		]);
	});

	it("缺少必须的默认层时明确失败", async () => {
		const definition: ConfigDefinition = {
			label: "missing-test",
			fileName: "missing-test-default.jsonc",
			userEnv: "PI_MISSING_TEST_CONFIG",
		};
		await expect(loadConfigLayers(definition, temp.path, (message, details) => Object.assign(new Error(message), { details })))
			.rejects.toMatchObject({ message: "missing-test default config is missing.", details: { layer: "default" } });
	});

	it("完整默认层校验要求所有固定字段，overlay schema 仍可保持稀疏", async () => {
		const schemaPath = path.join(temp.path, "complete.schema.json");
		await writeFile(schemaPath, JSON.stringify({
			type: "object",
			additionalProperties: false,
			properties: {
				enabled: { type: "boolean" },
				nested: {
					type: "object",
					additionalProperties: false,
					properties: { value: { type: "integer" } },
				},
			},
		}));
		const validate = await createCompleteSchemaValidator({
			schemaPath,
			label: "complete-test",
			createError: (message) => new Error(message),
		})();
		expect(validate({ enabled: true, nested: {} })).toBe(false);
		expect(validate({ enabled: true, nested: { value: 1 } })).toBe(true);
	});

	it("递归合并对象并整体替换数组和标量", () => {
		expect(mergeConfigValues(
			{ nested: { inherited: true, value: 1 }, list: [1, 2], scalar: "base" },
			{ nested: { value: 2 }, list: [3], scalar: "overlay" },
		)).toEqual({ nested: { inherited: true, value: 2 }, list: [3], scalar: "overlay" });
	});
});
