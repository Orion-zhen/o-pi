import type { GuiSnapshot } from "../contract.ts";

export function modelSetup(snapshot: Pick<GuiSnapshot, "model" | "models">) {
	if (snapshot.models.length === 0) return {
		kind: "auth",
		title: "连接模型",
		action: "添加模型服务",
	} as const;
	if (!snapshot.models.some((model) => model.provider === snapshot.model?.provider && model.id === snapshot.model.id)) return {
		kind: "model",
		title: "开始对话",
		action: "选择模型",
	} as const;
	return null;
}
