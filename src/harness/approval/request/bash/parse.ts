import type { ApprovalUnit, BashApprovalRequest, BashPipeline } from "../../types.ts";
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
	const pipelines: BashPipeline[] = [];
	const units = await parseBashApprovalUnits(command, cwd, pipelines, startup, unknownStartup);
	if (script !== command) {
		units.push(...await parseBashApprovalUnits(script, cwd, pipelines, startup, false));
		units.push({ action: "execute", target: { kind: "command", value: command }, remember: false });
	}
	return {
		tool: "bash", cwd: normalizeTargetPath(".", cwd),
		detail: { command, ...(used.size ? { environment: Object.fromEntries(used) } : {}) },
		units, pipelines,
		allowSessionMemory: used.size === 0 && !unknownStartup,
	};
}

async function parseBashApprovalUnits(command: string, cwd: string, pipelines: BashPipeline[], startup: StartupFacts | undefined, requireOpaque: boolean): Promise<ApprovalUnit[]> {
	const units: ApprovalUnit[] = [];
	const parsed = await analyzeBashScript(command, cwd, { units, pipelines }, startup);
	const opaque = !parsed || requireOpaque;
	if (opaque || units.length === 0) units.push({
		action: "execute", target: { kind: "command", value: normalizeSource(command) }, remember: true,
		...(opaque && { analysisFact: "execution.opaque" }),
	});
	return units;
}
