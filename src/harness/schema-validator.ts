export interface SchemaValidationError {
	instancePath: string;
	keyword: string;
	params: Record<string, unknown>;
	message?: string;
}

export interface SchemaValidateFunction {
	(value: unknown): boolean;
	errors?: SchemaValidationError[] | null;
}

interface ValidationContext {
	errors: SchemaValidationError[];
	allErrors: boolean;
}

type JsonSchema = boolean | Record<string, unknown>;

const SUPPORTED_SCHEMA_KEYS = new Set([
	"$defs",
	"$id",
	"$ref",
	"$schema",
	"additionalProperties",
	"anyOf",
	"const",
	"default",
	"description",
	"enum",
	"exclusiveMinimum",
	"items",
	"maxItems",
	"maxLength",
	"maximum",
	"minItems",
	"minLength",
	"minimum",
	"pattern",
	"patternProperties",
	"properties",
	"required",
	"title",
	"type",
	"uniqueItems",
]);

/** Compile the JSON Schema subset used by this repository without runtime code generation. */
export function compileSchemaValidator(schema: object, options: { allErrors?: boolean } = {}): SchemaValidateFunction {
	if (!isRecord(schema)) throw new Error("schema root must be an object");
	assertSupportedSchema(schema, new Set());
	const root = schema;
	const validate: SchemaValidateFunction = (value: unknown): boolean => {
		const context: ValidationContext = { errors: [], allErrors: options.allErrors ?? false };
		const valid = validateSchema(root, value, "", root, context);
		validate.errors = valid ? null : context.errors;
		return valid;
	};
	return validate;
}

function assertSupportedSchema(schema: JsonSchema, seen: Set<object>): void {
	if (typeof schema === "boolean" || seen.has(schema)) return;
	seen.add(schema);
	for (const key of Object.keys(schema)) {
		if (!SUPPORTED_SCHEMA_KEYS.has(key)) throw new Error(`unsupported schema keyword: ${key}`);
	}
	const pattern = schema["pattern"];
	if (pattern !== undefined) {
		if (typeof pattern !== "string") throw new Error("schema pattern must be a string");
		new RegExp(pattern, "u");
	}
	for (const containerName of ["$defs", "properties", "patternProperties"] as const) {
		const container = schema[containerName];
		if (container === undefined) continue;
		if (!isRecord(container)) throw new Error(`${containerName} must be an object`);
		for (const [key, child] of Object.entries(container)) {
			if (containerName === "patternProperties") new RegExp(key, "u");
			if (!isSchema(child)) throw new Error(`${containerName} values must be schemas`);
			assertSupportedSchema(child, seen);
		}
	}
	const items = schema["items"];
	if (items !== undefined) {
		if (!isSchema(items)) throw new Error("items must be a schema");
		assertSupportedSchema(items, seen);
	}
	const additional = schema["additionalProperties"];
	if (additional !== undefined) {
		if (!isSchema(additional)) throw new Error("additionalProperties must be a schema");
		assertSupportedSchema(additional, seen);
	}
	const anyOf = schema["anyOf"];
	if (anyOf !== undefined) {
		if (!Array.isArray(anyOf)) throw new Error("anyOf must be an array");
		for (const child of anyOf) {
			if (!isSchema(child)) throw new Error("anyOf entries must be schemas");
			assertSupportedSchema(child, seen);
		}
	}
}

function validateSchema(schema: JsonSchema, value: unknown, instancePath: string, root: object, context: ValidationContext): boolean {
	if (typeof schema === "boolean") {
		return schema || fail(context, instancePath, "false schema", {}, "must not be present");
	}
	const reference = schema["$ref"];
	if (typeof reference === "string") return validateSchema(resolveReference(root, reference), value, instancePath, root, context);

	let valid = true;
	const anyOf = schema["anyOf"];
	if (Array.isArray(anyOf)) {
		let matched = false;
		for (const candidate of anyOf) {
			if (!isSchema(candidate)) throw new Error("anyOf entries must be schemas");
			const branch: ValidationContext = { errors: [], allErrors: context.allErrors };
			if (validateSchema(candidate, value, instancePath, root, branch)) {
				matched = true;
				break;
			}
		}
		if (!matched) {
			valid = fail(context, instancePath, "anyOf", {}, "must match a schema in anyOf") && valid;
			if (!context.allErrors) return false;
		}
	}

	valid = validateConstAndEnum(schema, value, instancePath, context) && valid;
	if (!valid && !context.allErrors) return false;
	const declaredType = schema["type"];
	if (declaredType !== undefined && !matchesType(declaredType, value)) {
		return fail(context, instancePath, "type", { type: declaredType }, `must be ${renderType(declaredType)}`) && valid;
	}
	if (typeof value === "string") valid = validateString(schema, value, instancePath, context) && valid;
	else if (typeof value === "number") valid = validateNumber(schema, value, instancePath, context) && valid;
	else if (Array.isArray(value)) valid = validateArray(schema, value, instancePath, root, context) && valid;
	else if (isRecord(value)) valid = validateObject(schema, value, instancePath, root, context) && valid;
	return valid;
}

function validateConstAndEnum(
	schema: Record<string, unknown>,
	value: unknown,
	instancePath: string,
	context: ValidationContext,
): boolean {
	if ("const" in schema && !jsonEqual(value, schema["const"])) {
		return fail(context, instancePath, "const", { allowedValue: schema["const"] }, "must be equal to constant");
	}
	const choices = schema["enum"];
	if (Array.isArray(choices) && !choices.some((choice) => jsonEqual(value, choice))) {
		return fail(context, instancePath, "enum", { allowedValues: choices }, "must be equal to one of the allowed values");
	}
	return true;
}

function validateString(
	schema: Record<string, unknown>,
	value: string,
	instancePath: string,
	context: ValidationContext,
): boolean {
	let valid = true;
	const minLength = schema["minLength"];
	if (typeof minLength === "number" && value.length < minLength) {
		valid = fail(context, instancePath, "minLength", { limit: minLength }, `must NOT have fewer than ${minLength} characters`) && valid;
		if (!context.allErrors) return false;
	}
	const maxLength = schema["maxLength"];
	if (typeof maxLength === "number" && value.length > maxLength) {
		valid = fail(context, instancePath, "maxLength", { limit: maxLength }, `must NOT have more than ${maxLength} characters`) && valid;
		if (!context.allErrors) return false;
	}
	const pattern = schema["pattern"];
	if (typeof pattern === "string" && !new RegExp(pattern, "u").test(value)) {
		valid = fail(context, instancePath, "pattern", { pattern }, `must match pattern ${JSON.stringify(pattern)}`) && valid;
	}
	return valid;
}

function validateNumber(
	schema: Record<string, unknown>,
	value: number,
	instancePath: string,
	context: ValidationContext,
): boolean {
	let valid = true;
	const minimum = schema["minimum"];
	if (typeof minimum === "number" && value < minimum) {
		valid = fail(context, instancePath, "minimum", { comparison: ">=", limit: minimum }, `must be >= ${minimum}`) && valid;
		if (!context.allErrors) return false;
	}
	const exclusiveMinimum = schema["exclusiveMinimum"];
	if (typeof exclusiveMinimum === "number" && value <= exclusiveMinimum) {
		valid = fail(context, instancePath, "exclusiveMinimum", { comparison: ">", limit: exclusiveMinimum }, `must be > ${exclusiveMinimum}`) && valid;
		if (!context.allErrors) return false;
	}
	const maximum = schema["maximum"];
	if (typeof maximum === "number" && value > maximum) {
		valid = fail(context, instancePath, "maximum", { comparison: "<=", limit: maximum }, `must be <= ${maximum}`) && valid;
	}
	return valid;
}

function validateArray(
	schema: Record<string, unknown>,
	value: unknown[],
	instancePath: string,
	root: object,
	context: ValidationContext,
): boolean {
	let valid = true;
	const minItems = schema["minItems"];
	if (typeof minItems === "number" && value.length < minItems) {
		valid = fail(context, instancePath, "minItems", { limit: minItems }, `must NOT have fewer than ${minItems} items`) && valid;
		if (!context.allErrors) return false;
	}
	const maxItems = schema["maxItems"];
	if (typeof maxItems === "number" && value.length > maxItems) {
		valid = fail(context, instancePath, "maxItems", { limit: maxItems }, `must NOT have more than ${maxItems} items`) && valid;
		if (!context.allErrors) return false;
	}
	if (schema["uniqueItems"] === true && new Set(value.map(stableJson)).size !== value.length) {
		valid = fail(context, instancePath, "uniqueItems", {}, "must NOT have duplicate items") && valid;
		if (!context.allErrors) return false;
	}
	const items = schema["items"];
	if (isSchema(items)) {
		for (let index = 0; index < value.length; index++) {
			valid = validateSchema(items, value[index], `${instancePath}/${index}`, root, context) && valid;
			if (!valid && !context.allErrors) return false;
		}
	}
	return valid;
}

function validateObject(
	schema: Record<string, unknown>,
	value: Record<string, unknown>,
	instancePath: string,
	root: object,
	context: ValidationContext,
): boolean {
	let valid = true;
	const required = schema["required"];
	if (Array.isArray(required)) {
		for (const property of required) {
			if (typeof property !== "string" || Object.hasOwn(value, property)) continue;
			valid = fail(context, instancePath, "required", { missingProperty: property }, `must have required property '${property}'`) && valid;
			if (!context.allErrors) return false;
		}
	}

	const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
	const patternProperties = compilePatternProperties(schema["patternProperties"]);
	const additional = schema["additionalProperties"];
	for (const [property, propertyValue] of Object.entries(value)) {
		const propertySchema = properties[property];
		let matched = false;
		if (isSchema(propertySchema)) {
			matched = true;
			valid = validateSchema(propertySchema, propertyValue, appendPath(instancePath, property), root, context) && valid;
			if (!valid && !context.allErrors) return false;
		}
		for (const pattern of patternProperties) {
			if (!pattern.expression.test(property)) continue;
			matched = true;
			valid = validateSchema(pattern.schema, propertyValue, appendPath(instancePath, property), root, context) && valid;
			if (!valid && !context.allErrors) return false;
		}
		if (matched || additional === undefined || additional === true) continue;
		if (additional === false) {
			valid = fail(context, instancePath, "additionalProperties", { additionalProperty: property }, "must NOT have additional properties") && valid;
		} else if (isSchema(additional)) {
			valid = validateSchema(additional, propertyValue, appendPath(instancePath, property), root, context) && valid;
		}
		if (!valid && !context.allErrors) return false;
	}
	return valid;
}

function compilePatternProperties(value: unknown): Array<{ expression: RegExp; schema: JsonSchema }> {
	if (!isRecord(value)) return [];
	const patterns: Array<{ expression: RegExp; schema: JsonSchema }> = [];
	for (const [pattern, schema] of Object.entries(value)) {
		if (!isSchema(schema)) throw new Error("patternProperties values must be schemas");
		patterns.push({ expression: new RegExp(pattern, "u"), schema });
	}
	return patterns;
}

function resolveReference(root: object, reference: string): JsonSchema {
	if (!reference.startsWith("#/")) throw new Error(`unsupported schema reference: ${reference}`);
	let current: unknown = root;
	for (const token of reference.slice(2).split("/")) {
		if (!isRecord(current)) throw new Error(`schema reference does not exist: ${reference}`);
		current = current[token.replace(/~1/g, "/").replace(/~0/g, "~")];
	}
	if (!isSchema(current)) throw new Error(`schema reference is not a schema: ${reference}`);
	return current;
}

function matchesType(type: unknown, value: unknown): boolean {
	if (Array.isArray(type)) return type.some((candidate) => matchesType(candidate, value));
	if (type === "null") return value === null;
	if (type === "array") return Array.isArray(value);
	if (type === "object") return isRecord(value);
	if (type === "integer") return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
	if (type === "number") return typeof value === "number" && Number.isFinite(value);
	return typeof type === "string" && typeof value === type;
}

function renderType(type: unknown): string {
	return Array.isArray(type) ? type.join(",") : String(type);
}

function appendPath(instancePath: string, property: string): string {
	return `${instancePath}/${property.replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

function fail(
	context: ValidationContext,
	instancePath: string,
	keyword: string,
	params: Record<string, unknown>,
	message: string,
): false {
	context.errors.push({ instancePath, keyword, params, message });
	return false;
}

function isSchema(value: unknown): value is JsonSchema {
	return typeof value === "boolean" || isRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonEqual(left: unknown, right: unknown): boolean {
	return Object.is(left, right) || stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (!isRecord(value)) return JSON.stringify(value) ?? String(value);
	return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}
