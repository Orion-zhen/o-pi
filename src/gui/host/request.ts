import { compile } from "@earendil-works/pi-schema";
import { requestSchema, type GuiRequest } from "../shared/protocol/connection.ts";

const validate = compile(requestSchema).check;

export function decodeGuiRequest(value: unknown): GuiRequest {
	if (!validate(value)) throw new Error("无效 GUI 请求，缺少目标会话。");
	return value;
}
