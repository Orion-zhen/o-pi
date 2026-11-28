import { expect, it } from "vitest";
import { moduleConfigOptions } from "../../../../src/gui/shared/config/module-schema.ts";

import { moduleGroups } from "../../../../src/gui/frontend/features/modules/module-fields.ts";
import { moduleConfigIds } from "../../../../src/gui/shared/config/modules.ts";
import { CONFIG_DEFINITIONS, configSchema } from "../../../../src/harness/config-loader.ts";

it("模块设置展示的字段都有非空 schema 标题", () => {
	for (const id of moduleConfigIds) {
		const { fields, arrayOptions } = moduleConfigOptions(configSchema(CONFIG_DEFINITIONS[id]).schema);
		const paths = moduleGroups[id].flatMap((group) => group.fields.map((field) => field.path));
		for (const { value } of arrayOptions["websearch.primary_providers"] ?? []) {
			const prefix = `websearch.${value}.`;
			paths.push(...Object.keys(fields).filter((path) => path.startsWith(prefix) && path !== `${prefix}enabled`));
		}
		for (const path of paths) expect(fields[path]?.title?.trim(), `${id}.${path}`).toBeTruthy();
	}
});

it("设置字段来自 schema，保留标题、默认值、约束和本地引用，不展开动态属性", () => {
	const metadata = moduleConfigOptions({
		$defs: { timeout: { type: "integer", title: "请求超时", minimum: 1, maximum: 60, default: 8 } },
		properties: { websearch: { properties: { custom: { properties: {
			timeout: { $ref: "#/$defs/timeout" },
			key: { type: "string", title: "密钥", minLength: 1, maxLength: 4096 },
			flag: { type: "boolean", default: false },
			mode: { title: "模式", enum: ["fast", "full"], default: "fast" },
			domains: { type: "array", items: { type: "string" }, default: [] },
			score: { type: "number", minimum: 0, maximum: 1 },
			headers: { type: "object", additionalProperties: { type: "string" } },
		} } } } },
	});
	expect(metadata.fields).toEqual({
		"websearch.custom.timeout": { type: "integer", title: "请求超时", minimum: 1, maximum: 60, default: 8 },
		"websearch.custom.key": { type: "string", title: "密钥", minLength: 1, maxLength: 4096 },
		"websearch.custom.flag": { type: "boolean", default: false },
		"websearch.custom.mode": { type: "string", title: "模式", default: "fast" },
		"websearch.custom.domains": { type: "array", default: [] },
		"websearch.custom.score": { type: "number", minimum: 0, maximum: 1 },
	});
	expect(metadata.options).toEqual({ "websearch.custom.mode": ["fast", "full"] });
});
