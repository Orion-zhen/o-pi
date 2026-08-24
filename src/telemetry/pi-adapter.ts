import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type {
	TelemetryPi,
	TelemetryService,
	TelemetrySessionContext,
} from "./service.js";

/** 把 Pi 生命周期和上下文映射为 telemetry 的窄输入。 */
export function attachTelemetryService(pi: Pick<TelemetryPi, "on">, service: TelemetryService): void {
	pi.on("session_start", (event, ctx) => service.onSessionStart(event, sessionContext(ctx)));
	pi.on("turn_start", (event, ctx) => service.onTurnStart(event, {
		...(ctx.model === undefined ? {} : { model: { provider: ctx.model.provider, id: ctx.model.id } }),
	}));
	pi.on("message_end", (event) => service.onMessageEnd(event));
	pi.on("tool_execution_start", (event) => service.onToolExecutionStart(event));
	pi.on("tool_result", (event) => service.onToolResult(event));
	pi.on("tool_execution_end", (event) => service.onToolExecutionEnd(event));
	pi.on("session_shutdown", (event) => service.onSessionShutdown(event));
}

function sessionContext(ctx: ExtensionContext): TelemetrySessionContext {
	return {
		cwd: ctx.cwd,
		sessionId: ctx.sessionManager.getSessionId(),
		notify(message) {
			try {
				ctx.ui.notify(message, "warning");
			} catch {
				// Writer failures may arrive after the Pi context becomes inactive.
			}
		},
	};
}
