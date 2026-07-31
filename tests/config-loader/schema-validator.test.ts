import { describe, expect, it } from "vitest";
import { compileSchemaValidator } from "../../src/schema-validator.js";

describe("schema validator", () => {
	it("校验对象字段、required、additionalProperties、patternProperties 和本地 ref", () => {
		const validate = compileSchemaValidator({
			type: "object",
			required: ["name", "labels"],
			properties: {
				name: { $ref: "#/$defs/name" },
				labels: { type: "object", patternProperties: { "^[a-z]+$": { type: "string" } }, additionalProperties: false },
			},
			additionalProperties: false,
			$defs: { name: { type: "string", minLength: 2, maxLength: 8, pattern: "^[a-z]+$" } },
		}, { allErrors: true });

		expect(validate({ name: "alpha", labels: { stable: "yes" } })).toBe(true);
		expect(validate.errors).toBeNull();
		expect(validate({ name: "A", labels: { "bad-key": 1 }, extra: true })).toBe(false);
		expect(validate.errors?.map((error) => error.keyword)).toEqual(expect.arrayContaining([
			"minLength",
			"pattern",
			"additionalProperties",
		]));
		expect(validate({ labels: {} })).toBe(false);
		expect(validate.errors?.[0]).toMatchObject({ keyword: "required", params: { missingProperty: "name" } });
	});

	it("校验数值、数组边界和结构相等的唯一项", () => {
		const validate = compileSchemaValidator({
			type: "array",
			minItems: 1,
			maxItems: 2,
			uniqueItems: true,
			items: {
				type: "object",
				required: ["count", "ratio"],
				properties: {
					count: { type: "integer", minimum: 1, maximum: 3 },
					ratio: { type: "number", exclusiveMinimum: 0 },
				},
			},
		});

		expect(validate([{ count: 2, ratio: 0.5 }])).toBe(true);
		expect(validate([])).toBe(false);
		expect(validate([{ count: 1, ratio: 1 }, { ratio: 1, count: 1 }])).toBe(false);
		expect(validate([{ count: 4, ratio: 0 }])).toBe(false);
		expect(validate([{ count: 1.5, ratio: 1 }])).toBe(false);
	});

	it("校验 anyOf、enum、const、nullable type 和 false schema", () => {
		const validate = compileSchemaValidator({
			type: "object",
			properties: {
				mode: { anyOf: [{ const: "auto" }, { enum: ["fast", "safe"] }] },
				value: { type: ["string", "null"] },
				forbidden: false,
			},
		});

		expect(validate({ mode: "fast", value: null })).toBe(true);
		expect(validate({ mode: "other", value: 1 })).toBe(false);
		expect(validate({ forbidden: true })).toBe(false);
	});

	it("anyOf 成功后继续校验同级关键字", () => {
		const validate = compileSchemaValidator({
			type: "object",
			required: ["value"],
			properties: { value: { type: "string" } },
			anyOf: [{ required: ["value"] }],
		});

		expect(validate({ value: "valid" })).toBe(true);
		expect(validate({ value: 1 })).toBe(false);
		expect(validate.errors).toEqual([
			expect.objectContaining({ instancePath: "/value", keyword: "type" }),
		]);
	});

	it("拒绝仓库校验器尚未实现的 schema 关键字", () => {
		expect(() => compileSchemaValidator({ type: "number", multipleOf: 2 })).toThrow("unsupported schema keyword: multipleOf");
	});
});
