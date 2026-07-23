import type { TSchema } from "typebox";

import type { RepairPath, RepairSpec, RepairSpecHints } from "./types.js";

interface SchemaNode {
	type?: string;
	required?: readonly string[];
	properties?: Record<string, TSchema>;
	items?: TSchema;
}

export function createRepairSpec(schema: TSchema, hints: RepairSpecHints = {}): RepairSpec {
	const inferred = inferSchemaRepairFields(schema);
	return {
		...hints,
		dropOptionalNull: hints.dropOptionalNull ?? true,
		pathFields: hints.pathFields ?? [],
		pathListFields: hints.pathListFields ?? [],
		aliases: hints.aliases ?? {},
		nestedAliases: hints.nestedAliases ?? {},
		objectArrayFromFields: hints.objectArrayFromFields ?? [],
		optionalFields: inferred.optionalFields,
		numericFields: inferred.numericFields,
		arrayFields: inferred.arrayFields,
		objectToArrayFields: unique([...inferred.objectArrayFields, ...(hints.objectToArrayFields ?? [])]),
		schema,
	};
}

function inferSchemaRepairFields(schema: TSchema): {
	optionalFields: RepairPath[];
	numericFields: RepairPath[];
	arrayFields: RepairPath[];
	objectArrayFields: RepairPath[];
} {
	const optionalFields: RepairPath[] = [];
	const numericFields: RepairPath[] = [];
	const arrayFields: RepairPath[] = [];
	const objectArrayFields: RepairPath[] = [];

	const visit = (node: TSchema, path: readonly string[]): void => {
		const schemaNode = node as SchemaNode;
		if (schemaNode.type === "number" || schemaNode.type === "integer") {
			numericFields.push(path.join("."));
			return;
		}
		if (schemaNode.type === "array" && schemaNode.items !== undefined) {
			arrayFields.push(path.join("."));
			const itemNode = schemaNode.items as SchemaNode;
			if (itemNode.type === "object") objectArrayFields.push(path.join("."));
			visit(schemaNode.items, [...path, "*"]);
			return;
		}
		if (schemaNode.type !== "object" || schemaNode.properties === undefined) return;

		const required = new Set(schemaNode.required ?? []);
		for (const [key, child] of Object.entries(schemaNode.properties)) {
			const childPath = [...path, key];
			if (!required.has(key)) optionalFields.push(childPath.join("."));
			visit(child, childPath);
		}
	};

	visit(schema, []);
	return {
		optionalFields: unique(optionalFields),
		numericFields: unique(numericFields),
		arrayFields: unique(arrayFields),
		objectArrayFields: unique(objectArrayFields),
	};
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)].filter((value) => value.length > 0);
}

