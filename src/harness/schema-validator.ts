import Ajv2020 from "ajv/dist/2020.js";
import draft7 from "ajv/dist/refs/json-schema-draft-07.json" with { type: "json" };
import type { ErrorObject } from "ajv";

export type SchemaValidationError = Pick<ErrorObject, "instancePath" | "keyword" | "params" | "message">;
export interface SchemaValidateFunction {
	(value: unknown): boolean;
	errors?: SchemaValidationError[] | null;
}

// 默认层与覆盖层会从同一 $id 派生不同的 required，不能按 $id 注册为同一 schema。
function createValidator(allErrors: boolean): Ajv2020 {
	const ajv = new Ajv2020({ allErrors, strict: false, addUsedSchema: false });
	ajv.addMetaSchema(draft7, "https://json-schema.org/draft-07/schema");
	return ajv;
}
const firstError = createValidator(false);
const allErrors = createValidator(true);

export function compileSchemaValidator(schema: object, options: { allErrors?: boolean } = {}): SchemaValidateFunction {
	return (options.allErrors ? allErrors : firstError).compile(schema);
}
