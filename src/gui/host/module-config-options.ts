import type { ModuleConfigDocument } from "../module-config.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 收集固定字段及选项，沿用本地引用，不展开动态属性。 */
export function moduleConfigOptions(schema: unknown): Pick<ModuleConfigDocument, "options" | "arrayOptions" | "fields"> {
	const options: ModuleConfigDocument["options"] = {};
	const arrayOptions: ModuleConfigDocument["arrayOptions"] = {};
	const fields: ModuleConfigDocument["fields"] = {};
	const visit = (node: unknown, path: string) => {
		if (!isRecord(node)) return;
		if (typeof node.$ref === "string") {
			const target = node.$ref.slice(2).split("/").reduce<unknown>((value, key) =>
				isRecord(value) ? value[key.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined, schema);
			visit(target, path);
			return;
		}
		const stringEnum = Array.isArray(node.enum) && node.enum.every((value: unknown) => typeof value === "string");
		const type = node.type ?? (stringEnum ? "string" : undefined);
		if (type === "string" || type === "boolean" || type === "integer" || type === "number" || type === "array") {
			const field: ModuleConfigDocument["fields"][string] = { type };
			if (typeof node.title === "string") field.title = node.title;
			if ("default" in node) field.default = node.default;
			for (const key of ["minimum", "maximum", "minLength", "maxLength"] as const) {
				if (typeof node[key] === "number") field[key] = node[key];
			}
			fields[path] = field;
		}
		if (Array.isArray(node.enum) && node.enum.every((value: unknown) => typeof value === "string")) options[path] = node.enum;
		if (isRecord(node.items) && Array.isArray(node.items.oneOf)
			&& node.items.oneOf.every((choice: unknown): choice is { const: string; title: string } => isRecord(choice) && typeof choice.const === "string" && typeof choice.title === "string")) {
			arrayOptions[path] = node.items.oneOf.map((choice) => ({ value: choice.const, label: choice.title }));
		}
		if (isRecord(node.properties)) {
			for (const [key, value] of Object.entries(node.properties)) visit(value, path ? `${path}.${key}` : key);
		}
	};
	visit(schema, "");
	return { options, arrayOptions, fields };
}
