import { compileSchemaValidator } from "../../harness/schema-validator.ts";
import { requestSchema, type GuiRequest } from "../contract.ts";

const validate = compileSchemaValidator(requestSchema);

export function decodeGuiRequest(value: unknown): GuiRequest {
	if (!validate(value)) throw new Error("无效 GUI 请求，缺少目标会话。");
	return value as GuiRequest;
}
