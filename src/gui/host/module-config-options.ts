import type { ModuleConfigDocument } from "../module-config.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 收集固定字段的字符串枚举和带标题的数组选项，沿用本地引用，不展开动态属性。 */
export function moduleConfigOptions(schema: unknown): Pick<ModuleConfigDocument, "options" | "arrayOptions"> {
	const options: ModuleConfigDocument["options"] = {};
	const arrayOptions: ModuleConfigDocument["arrayOptions"] = {};
	const visit = (node: unknown, path: string) => {
		if (!isRecord(node)) return;
		if (typeof node.$ref === "string") {
			const target = node.$ref.slice(2).split("/").reduce<unknown>((value, key) =>
				isRecord(value) ? value[key.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined, schema);
			visit(target, path);
			return;
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
	return { options, arrayOptions };
}
