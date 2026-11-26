import type { ApprovalUnit, BashApprovalRequest, BashPipeline } from "../../types.ts";
import { normalizeTargetPath } from "../path.ts";
import { analyzeBashScript } from "./analysis.ts";
import { hasStartupHooks } from "./startup.ts";
import { normalizeSource } from "./syntax.ts";

interface BashExecutionInput {
	cwd: string;
	command: string;
	env: Readonly<NodeJS.ProcessEnv>;
}

export async function buildBashApprovalRequest(command: string, { cwd, command: script, env }: BashExecutionInput,
	{ askpass, signal }: { askpass: boolean; signal?: AbortSignal | undefined },
): Promise<BashApprovalRequest & { askpassCommand?: string }> {
	const used = new Map<string, string | null>();
	const unknownStartup = hasStartupHooks(env);
	const startup = unknownStartup ? undefined : { env, used };
	const pipelines: BashPipeline[] = [];
	const units: ApprovalUnit[] = [];
	async function inspect(source: string, requireOpaque: boolean) {
		const parsedUnits: ApprovalUnit[] = [];
		const inspectSudo = source === script && askpass && (process.platform === "darwin" || process.platform === "linux");
		const parsed = await analyzeBashScript(source, cwd, { units: parsedUnits, pipelines, signal }, startup, inspectSudo);
		const opaque = !parsed || requireOpaque;
		units.push(...parsedUnits);
		if (opaque || parsedUnits.length === 0) units.push({
			action: "execute", target: { kind: "command", value: normalizeSource(source) }, remember: true,
			...(opaque && { analysisFact: "execution.opaque" }),
		});
		return parsed?.askpassCommand;
	}
	let askpassCommand = await inspect(command, unknownStartup);
	if (script !== command) {
		askpassCommand = await inspect(script, false);
		units.push({ action: "execute", target: { kind: "command", value: command }, remember: false });
	}
	return {
		tool: "bash", cwd: normalizeTargetPath(".", cwd),
		detail: { command, ...(used.size ? { environment: Object.fromEntries(used) } : {}) },
		units, pipelines, ...(askpassCommand && { askpassCommand }),
		allowSessionMemory: !askpassCommand && used.size === 0 && !unknownStartup,
	};
}
