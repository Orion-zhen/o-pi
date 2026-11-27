import { parsePowerShell } from "./powershell/syntax.ts";
import { SyntaxAnalysisTimeoutError } from "../../syntax-tree/parser.ts";
import type { ApprovalUnit, ShellApprovalRequest, ShellPipeline } from "../types.ts";
import { normalizeTargetPath } from "./path.ts";
import { analyzePowerShell } from "./powershell/analysis.ts";
import { IncompletePowerShellAnalysis } from "./powershell/locations.ts";
import { initialFlow, type Environment } from "./powershell/flow.ts";
import { pushUnit, writeRedirect, type AnalysisState } from "./powershell/units.ts";

export async function buildPowerShellApprovalRequest(command: string, call: { cwd: string; command: string; env: Readonly<NodeJS.ProcessEnv> }, signal?: AbortSignal): Promise<ShellApprovalRequest> {
	const units: ApprovalUnit[] = [], pipelines: ShellPipeline[] = [];
	const cwd = normalizeTargetPath(".", call.cwd);
	const env: Environment = { values: new Map(Object.entries(call.env).map(entry => [entry[0].toLowerCase(), entry])), used: new Map() };
	let allowSessionMemory = command === call.command;
	for (const script of new Set([command, call.command])) {
		const start = units.length;
		let incomplete: string | undefined;
		const state: AnalysisState = { units, pipelines, env, unitLimit: start + 256, display: command,
			pending: [{ kind: script === call.command ? "final-script" : "script", code: script, flow: initialFlow(cwd), depth: 0 }] };
		try {
			for (const input of state.pending) {
				const parsed = await parsePowerShell(input, signal);
				if (parsed.kind === "invalid-script") {
					return { tool: "powershell", cwd, detail: { command }, allowSessionMemory: false, pipelines: [], units: [{
						action: "execute", target: { kind: "command", value: command }, effect_scope: "none", remember: false,
					}] };
				}
				if (parsed.kind === "opaque") {
					incomplete ??= parsed.reason;
					if (parsed.commands?.length) pushUnit(state, { action: "execute", target: { kind: "command", value: input.code }, commands: parsed.commands, remember: false });
					continue;
				}
				allowSessionMemory &&= parsed.allowSessionMemory;
				const { tree, code } = parsed;
				try {
					if (input.kind === "redirect") {
						const expr = tree.root.firstNamedChild?.firstNamedChild;
						writeRedirect({ source: input.source, value: undefined,
							...(expr?.type === "pipeline" && expr.text === code && { expression: expr }) }, input.flow, input.depth, state);
					} else analyzePowerShell(tree, input, state, code);
				} finally { tree.dispose(); }
			}
		} catch (error) {
			if (!(error instanceof SyntaxAnalysisTimeoutError || error instanceof IncompletePowerShellAnalysis)) throw error;
			incomplete ??= error instanceof SyntaxAnalysisTimeoutError ? "Analysis timed out." : "Analysis limit reached.";
		}
		if (incomplete || units.length === start) {
			allowSessionMemory = false;
			units.push({ action: "execute", target: { kind: "command", value: script }, ...(incomplete && { analysisFact: "shell.run-opaque-input", analysisNote: incomplete }), remember: false });
		}
	}
	return { tool: "powershell", cwd, units, pipelines, detail: { command, ...(env.used.size && { environment: Object.fromEntries(env.used) }) },
		allowSessionMemory: allowSessionMemory && !env.used.size && !units.some(unit => unit.analysisFact) };
}
