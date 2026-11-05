import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthType } from "@earendil-works/pi-ai";
import type { GuiEvent } from "../../shared/protocol/events.ts";
import type { GuiDialogs } from "./dialogs.ts";

export async function runLogin(
	models: Pick<ModelRuntime, "login">,
	provider: string,
	type: AuthType,
	dialogs: GuiDialogs,
	emit: (event: GuiEvent) => void,
	controller: AbortController,
	getDeviceId: () => string,
): Promise<void> {
	const { signal } = controller;
	await models.login(provider, type, {
		signal,
		notify: (value) => emit({ type: "auth", value }),
		prompt: async (prompt) => {
			const promptSignal = prompt.signal ? AbortSignal.any([signal, prompt.signal]) : signal;
			const value = await dialogs.ask(prompt.type === "select"
				? { kind: "select", title: prompt.message, options: prompt.options.map((option) => ({ label: `${option.label} [${option.id}]`, value: option.id })) }
				: { kind: prompt.type === "secret" ? "secret" : "input", title: prompt.message, placeholder: prompt.placeholder ?? "", initial: "" },
			{ signal: promptSignal });
			if (value === undefined) {
				// SDK 可单独关闭备用输入，只有用户取消才终止整个登录。
				promptSignal.throwIfAborted();
				controller.abort();
				throw signal.reason;
			}
			return value;
		},
	}, { getDeviceId });
	if (type === "oauth") emit({ type: "feedback", message: `已连接 ${provider}`, tone: "success" });
}
