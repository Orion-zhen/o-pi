import { writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
	CONFIG_DEFINITIONS,
	createCompleteSchemaValidator,
	defaultAgentConfigPath,
	loadConfigLayers,
	loadValidatedMergedConfig,
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
		expect(projectEnabled).toEqual(["discordPresence", "fileTools", "lsp", "subagent"]);
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

	it.each([
		{
			name: "要求所有固定字段",
			optional: [],
			cases: [[{ enabled: true, nested: {} }, false], [{ enabled: true, nested: { value: 1 } }, true]],
		},
		{
			name: "允许模块运行时补齐字段",
			optional: ["nested"],
			cases: [[{ enabled: true }, true], [{ enabled: true, nested: {} }, false], [{ enabled: true, nested: { value: 1 } }, true]],
		},
	] as const)("完整默认层校验$name", async ({ optional, cases }) => {
		const schemaPath = await writeCompleteSchema("complete.schema.json");
		const validate = await createCompleteSchemaValidator({
			schemaPath,
			label: "complete-test",
			optionalCompleteProperties: optional,
			createError: (message) => new Error(message),
		})();
		for (const [value, expected] of cases) expect(validate(value)).toBe(expected);
	});

	it("逐层校验后合并配置，并保留加载快照信息", async () => {
		const user = path.join(temp.path, "approval-user.jsonc");
		await writeFile(user, '{ "enabled": false, "ui": { "timeout_ms": 25 } }');
		process.env.PI_APPROVAL_GATE_CONFIG = user;
		const completeValues: unknown[] = [];
		const partialValues: unknown[] = [];

		const loaded = await loadValidatedMergedConfig(
			CONFIG_DEFINITIONS.approvalGate,
			temp.path,
			(message, details) => Object.assign(new Error(message), { details }),
			{
				partial: async () => (value) => {
					partialValues.push(value);
					return true;
				},
				complete: async () => (value) => {
					completeValues.push(value);
					return true;
				},
			},
		);

		expect(completeValues).toHaveLength(1);
		expect(partialValues).toEqual([{ enabled: false, ui: { timeout_ms: 25 } }]);
		expect(loaded.merged).toMatchObject({
			enabled: false,
			ui: { timeout_ms: 25, non_interactive: "block" },
		});
		expect(loaded.fingerprint).toContain("default:");
	});

	it("在合并前报告无效覆盖层的诊断上下文", async () => {
		const user = path.join(temp.path, "invalid-user.jsonc");
		await writeFile(user, '{ "enabled": false }');
		process.env.PI_APPROVAL_GATE_CONFIG = user;

		await expect(loadValidatedMergedConfig(
			CONFIG_DEFINITIONS.approvalGate,
			temp.path,
			(message, details) => Object.assign(new Error(message), { details }),
			{
				partial: async () => Object.assign(() => false, {
					errors: [{ instancePath: "/enabled", keyword: "type", params: {} }],
				}),
				complete: async () => () => true,
			},
		)).rejects.toMatchObject({
			message: "approval-gate user config does not match schema.",
			details: { layer: "user", path: user },
		});
	});

	it("递归合并对象并整体替换数组和标量", () => {
		expect(mergeConfigValues(
			{ nested: { inherited: true, value: 1 }, list: [1, 2], scalar: "base" },
			{ nested: { value: 2 }, list: [3], scalar: "overlay" },
		)).toEqual({ nested: { inherited: true, value: 2 }, list: [3], scalar: "overlay" });
	});
});

async function writeCompleteSchema(name: string): Promise<string> {
	const schemaPath = path.join(temp.path, name);
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
	return schemaPath;
}
