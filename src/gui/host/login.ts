import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthType } from "@earendil-works/pi-ai";
import type { GuiEvent } from "../contract.ts";
import type { GuiDialogs } from "./dialogs.ts";

export async function runLogin(
	models: ModelRuntime,
	provider: string,
	type: AuthType,
	dialogs: GuiDialogs,
	emit: (event: GuiEvent) => void,
	signal: AbortSignal,
): Promise<void> {
	await models.login(provider, type, {
		signal,
		notify: (value) => emit({ type: "auth", value }),
		prompt: async (prompt) => {
			const promptSignal = prompt.signal ? AbortSignal.any([signal, prompt.signal]) : signal;
			const options = prompt.type === "select" ? prompt.options.map((option) => `${option.label} [${option.id}]`) : [];
			const value = await dialogs.ask(
				prompt.type === "secret" ? "secret" : prompt.type === "select" ? "select" : "input",
				prompt.message,
				"placeholder" in prompt ? (prompt.placeholder ?? "") : "",
				options,
				"",
				{ signal: promptSignal },
			);
			if (value === undefined) throw new Error("登录已取消。");
			if (prompt.type !== "select") return value;
			const option = prompt.options[options.indexOf(value)];
			if (!option) throw new Error("无效登录选项。");
			return option.id;
		},
	});
	dialogs.notify(`${provider} 登录成功。`);
}
