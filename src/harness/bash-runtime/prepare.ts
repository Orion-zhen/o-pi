import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadBashToolConfig } from "./config.ts";
import { createExecutionEnvironment } from "./environment.ts";
import { resolveBashSkillPaths } from "./skill-paths.ts";

export interface BashParams {
	command: string;
	timeout?: number;
	workdir?: string;
}

export async function prepareBashCall(params: BashParams, ctx: ExtensionContext, signal = ctx.signal) {
	const sessionFile = ctx.sessionManager.getSessionFile();
	const config = await loadBashToolConfig();
	const cwd = params.workdir ? path.resolve(ctx.cwd, params.workdir) : ctx.cwd;
	const branch = ctx.sessionManager.getBranch();
	const session = {
		sessionId: ctx.sessionManager.getSessionId(),
		...(sessionFile === undefined ? {} : { sessionFile }),
		...(ctx.model === undefined ? {} : { provider: ctx.model.provider, model: ctx.model.id }),
		...(ctx.thinkingLevel === undefined ? {} : { reasoningLevel: ctx.thinkingLevel }),
	};
	const script = await resolveBashSkillPaths(params.command, branch, signal);
	if (script.kind === "error") return script;
	return {
		...script, cwd, env: await createExecutionEnvironment(cwd, session, config),
		timeout: params.timeout ?? config.default_timeout_seconds, limits: config.limits, sessionId: session.sessionId,
	};
}

export type PreparedBashCommand = Awaited<ReturnType<typeof prepareBashCall>>;

// Pi 将同一个校验后的参数对象交给 tool_call 和 execute。快照不随参数序列化。
const saved = new WeakMap<object, Extract<PreparedBashCommand, { kind: "resolved" }>>();

export function saveBashCall(input: object, call: Extract<PreparedBashCommand, { kind: "resolved" }>): void {
	saved.set(input, call);
}

export function takeBashCall(params: BashParams, ctx: ExtensionContext, signal?: AbortSignal) {
	const call = saved.get(params);
	if (!call) return prepareBashCall(params, ctx, signal);
	saved.delete(params);
	return call;
}
