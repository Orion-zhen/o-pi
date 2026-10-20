import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CODEX_SPEED_CHANGED, CODEX_SPEEDS, getCodexSpeed, isCodexSpeed, setCodexSpeed } from "../codex-speed/state.ts";

export default function codexSpeedExtension(pi: ExtensionAPI): void {
	pi.registerCommand("codex-speed", {
		description: "Set OpenAI speed: normal|fast|ultrafast.",
		getArgumentCompletions: (prefix) => CODEX_SPEEDS
			.filter((speed) => speed.startsWith(prefix.trim()))
			.map((speed) => ({ value: speed, label: speed })),
		async handler(args, ctx) {
			const speed = args.trim();
			if (!isCodexSpeed(speed)) {
				ctx.ui.notify("Usage: /codex-speed normal|fast|ultrafast", "error");
				return;
			}
			if (setCodexSpeed(ctx.model?.provider, speed, ctx.sessionManager.getBranch(), (type, data) => pi.appendEntry(type, data))) {
				pi.events.emit(CODEX_SPEED_CHANGED, undefined);
			}
			ctx.ui.notify(`Codex speed: ${speed}`, "info");
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		const provider = ctx.model?.provider;
		const speed = getCodexSpeed(provider, ctx.sessionManager.getBranch());
		if (speed === null) return;
		if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
			throw new Error("Invalid OpenAI request payload.");
		}
		const payload: Record<string, unknown> = { ...event.payload };
		// Codex 省略档位表示普通速度，API 显式覆盖项目的默认档位。
		if (speed === "normal" && provider === "openai-codex") delete payload.service_tier;
		else payload.service_tier = speed === "normal" ? "default" : speed === "fast" ? "priority" : "ultrafast";
		return payload;
	});
}
