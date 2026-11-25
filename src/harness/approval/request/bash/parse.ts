import type { ApprovalUnit, BashApprovalRequest } from "../../types.ts";
import { normalizeTargetPath } from "../path.ts";
import { analyzeBashScript } from "./analysis.ts";
import { hasStartupHooks, type StartupFacts } from "./startup.ts";
import { normalizeSource } from "./syntax.ts";

interface BashExecutionInput {
	cwd: string;
	command: string;
	env: Readonly<NodeJS.ProcessEnv>;
}

export async function buildBashApprovalRequest(command: string, { cwd, command: script, env }: BashExecutionInput): Promise<BashApprovalRequest> {
	const used = new Map<string, string | null>();
	const unknownStartup = hasStartupHooks(env);
	const startup = unknownStartup ? undefined : { env, used };
	const units = await parseBashApprovalUnits(command, cwd, startup, unknownStartup);
	if (script !== command) {
		units.push(...await parseBashApprovalUnits(script, cwd, startup, false));
		units.push({ action: "execute", target: { kind: "command", value: command, effective_value: script, shell_input: script }, remember: false });
	}
	return {
		tool: "bash", cwd: normalizeTargetPath(".", cwd),
		detail: { command, ...(used.size ? { environment: Object.fromEntries(used) } : {}) },
		units,
		allowSessionMemory: used.size === 0 && !unknownStartup,
	};
}

async function parseBashApprovalUnits(command: string, cwd: string, startup: StartupFacts | undefined, requireOpaque: boolean): Promise<ApprovalUnit[]> {
	const units: ApprovalUnit[] = [];
	const parsed = await analyzeBashScript(command, cwd, units, startup);
	if (parsed && units.length === 0) units.push({
		action: "execute", target: { kind: "command", value: normalizeSource(command), effective_value: command }, remember: true,
	});
	if (!parsed || requireOpaque) units.push({
		action: "execute", target: { kind: "command", value: normalizeSource(command), effective_value: `<opaque> ${command}` }, remember: true,
	});
	return units;
}
