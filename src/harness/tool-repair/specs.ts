import type { TSchema } from "typebox";

import type { RepairPath, RepairSpec, RepairSpecHints } from "./types.ts";

interface SchemaNode {
	type?: string;
	properties?: Record<string, TSchema>;
	items?: TSchema;
}

export function createRepairSpec(schema: TSchema, hints: RepairSpecHints = {}): RepairSpec {
	const inferred = inferSchemaRepairFields(schema);
	return {
		...hints,
		pathFields: hints.pathFields ?? [],
		pathListFields: hints.pathListFields ?? [],
		aliases: hints.aliases ?? {},
		nestedAliases: hints.nestedAliases ?? {},
		objectArrayFromFields: hints.objectArrayFromFields ?? [],
		arrayFields: inferred.arrayFields,
		objectToArrayFields: inferred.objectArrayFields,
		schema,
	};
}

function inferSchemaRepairFields(schema: TSchema): {
	arrayFields: RepairPath[];
	objectArrayFields: RepairPath[];
} {
	const arrayFields: RepairPath[] = [];
	const objectArrayFields: RepairPath[] = [];

	const visit = (node: TSchema, path: readonly string[]): void => {
		const schemaNode = node as SchemaNode;
		if (schemaNode.type === "array" && schemaNode.items !== undefined) {
			arrayFields.push(path.join("."));
			const itemNode = schemaNode.items as SchemaNode;
			if (itemNode.type === "object") objectArrayFields.push(path.join("."));
			visit(schemaNode.items, [...path, "*"]);
			return;
		}
		if (schemaNode.type !== "object" || schemaNode.properties === undefined) return;

		for (const [key, child] of Object.entries(schemaNode.properties)) {
			const childPath = [...path, key];
			visit(child, childPath);
		}
	};

	visit(schema, []);
	return {
		arrayFields: unique(arrayFields),
		objectArrayFields: unique(objectArrayFields),
	};
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)].filter((value) => value.length > 0);
}
