import path from "node:path";
import type { Askpass } from "./askpass.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadShellToolsConfig } from "./config.ts";
import { createExecutionEnvironment } from "./environment.ts";
import type { ShellName } from "./platform.ts";
import { resolveShellSkillPaths } from "./skill-paths.ts";

export interface ShellParams {
	command: string;
	timeout?: number;
	workdir?: string;
}

export async function prepareShellCall(shell: ShellName, params: ShellParams, ctx: ExtensionContext, signal = ctx.signal) {
	const sessionFile = ctx.sessionManager.getSessionFile();
	const config = await loadShellToolsConfig();
	const cwd = params.workdir ? path.resolve(ctx.cwd, params.workdir) : ctx.cwd;
	const session = {
		sessionId: ctx.sessionManager.getSessionId(),
		...(sessionFile === undefined ? {} : { sessionFile }),
		...(ctx.model === undefined ? {} : { provider: ctx.model.provider, model: ctx.model.id }),
		...(ctx.thinkingLevel === undefined ? {} : { reasoningLevel: ctx.thinkingLevel }),
	};
	const script = await resolveShellSkillPaths(shell, params.command, ctx.sessionManager, signal);
	if (script.kind === "error") return { ...script, shell };
	return {
		...script, cwd, env: await createExecutionEnvironment(cwd, session, config),
		timeout: params.timeout ?? config.default_timeout_seconds, limits: config.limits, sessionId: session.sessionId,
	};
}

type ShellPreparation = Awaited<ReturnType<typeof prepareShellCall>>;
type ResolvedShellCommand = Extract<ShellPreparation, { kind: "resolved" }> & { askpass?: Askpass };
export type PreparedShellCommand = Extract<ShellPreparation, { kind: "error" }> | ResolvedShellCommand;

// Pi 将同一个校验后的参数对象交给 tool_call 和 execute。快照不随参数序列化。
const saved = new WeakMap<ShellParams, ResolvedShellCommand>();

export function saveShellCall(input: ShellParams, call: ResolvedShellCommand): void {
	saved.set(input, call);
}

export async function takeShellCall(shell: ShellName, params: ShellParams, ctx: ExtensionContext, signal?: AbortSignal): Promise<PreparedShellCommand> {
	const call = saved.get(params);
	saved.delete(params);
	return call ?? prepareShellCall(shell, params, ctx, signal);
}
