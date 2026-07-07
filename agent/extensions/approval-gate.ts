import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createApprovalGate } from "../../src/approval/gate.js";

export default function approvalGateExtension(pi: ExtensionAPI): void {
	const gate = createApprovalGate();
	pi.on("tool_call", async (event, ctx) => gate.handleToolCall(event, ctx));
}
