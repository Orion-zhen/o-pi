import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type {
	TelemetryPi,
	TelemetryService,
	TelemetrySessionContext,
} from "./service.js";

const attachedServices = new WeakSet<TelemetryService>();

/** 把 Pi lifecycle/context 映射为 telemetry application 的窄输入。 */
export function attachTelemetryService(pi: Pick<TelemetryPi, "on">, service: TelemetryService): void {
	if (attachedServices.has(service)) return;
	attachedServices.add(service);
	try {
		pi.on("session_start", (event, ctx) => {
			void service.onSessionStart(event, sessionContext(ctx));
		});
	} catch {}
	try {
		pi.on("turn_start", (event, ctx) => service.onTurnStart(event, {
			...(ctx.model === undefined ? {} : { model: { provider: ctx.model.provider, id: ctx.model.id } }),
		}));
	} catch {}
	try { pi.on("message_end", (event) => service.onMessageEnd(event)); } catch {}
	try { pi.on("tool_execution_start", (event) => service.onToolExecutionStart(event)); } catch {}
	try { pi.on("tool_result", (event) => service.onToolResult(event)); } catch {}
	try { pi.on("tool_execution_end", (event) => service.onToolExecutionEnd(event)); } catch {}
	try { pi.on("session_shutdown", (event) => service.onSessionShutdown(event)); } catch {}
}

function sessionContext(ctx: ExtensionContext): TelemetrySessionContext {
	let sessionId = "unknown";
	try {
		sessionId = ctx.sessionManager.getSessionId();
	} catch {}
	return {
		cwd: ctx.cwd,
		sessionId,
		notify(message) {
			try {
				ctx.ui.notify(message, "warning");
			} catch {}
		},
	};
}
