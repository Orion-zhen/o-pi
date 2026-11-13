import type { ModuleConfigMetadata } from "./modules.ts";

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 从同一份 schema 收集控件元数据，不展开动态属性。 */
export function moduleConfigOptions(schema: unknown): ModuleConfigMetadata {
	const options: ModuleConfigMetadata["options"] = {};
	const arrayOptions: ModuleConfigMetadata["arrayOptions"] = {};
	const fields: ModuleConfigMetadata["fields"] = {};
	const visit = (node: unknown, path: string) => {
		if (!record(node)) return;
		if (typeof node.$ref === "string") {
			visit(node.$ref.slice(2).split("/").reduce<unknown>((value, key) => record(value) ? value[key.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined, schema), path);
			return;
		}
		const variants = Array.isArray(node.anyOf) ? node.anyOf.filter(record) : [node];
		const definition = variants.find((variant) => variant.type !== "null");
		if (!definition) return;
		const types = Array.isArray(definition.type) ? definition.type : [definition.type];
		const stringEnum = Array.isArray(definition.enum) && definition.enum.every((value: unknown) => typeof value === "string");
		const type = types.find((type) => type !== "null") ?? (stringEnum ? "string" : undefined);
		if (type === "string" || type === "boolean" || type === "integer" || type === "number" || type === "array") {
			const field: ModuleConfigMetadata["fields"][string] = { type };
			if (types.includes("null") || variants.some((variant) => variant.type === "null")) field.nullable = true;
			if (typeof node.title === "string") field.title = node.title;
			if ("default" in node) field.default = node.default;
			for (const key of ["minimum", "maximum", "minLength", "maxLength"] as const) {
				if (typeof definition[key] === "number") field[key] = definition[key];
			}
			fields[path] = field;
		}
		if (Array.isArray(definition.enum) && definition.enum.every((value: unknown): value is string => typeof value === "string")) options[path] = definition.enum;
		if (record(node.items) && Array.isArray(node.items.oneOf)
			&& node.items.oneOf.every((choice: unknown): choice is { const: string; title: string } => record(choice) && typeof choice.const === "string" && typeof choice.title === "string")) {
			arrayOptions[path] = node.items.oneOf.map((choice) => ({ value: choice.const, label: choice.title }));
		}
		if (record(node.properties)) for (const [key, value] of Object.entries(node.properties)) visit(value, path ? `${path}.${key}` : key);
	};
	visit(schema, "");
	return { options, arrayOptions, fields };
}
