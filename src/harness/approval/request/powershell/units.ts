import type { PowerShellRedirectTarget } from "../../../syntax-tree/powershell.ts";
import type { ApprovalUnit, ShellPipeline } from "../../types.ts";
import { isSystemTemporaryDescendant } from "../path.ts";
import { wordValues } from "./commands.ts";
import { choices, type Environment, type Flow } from "./flow.ts";
import { filePath, IncompletePowerShellAnalysis } from "./locations.ts";

interface Input { code: string; flow: Flow; depth: number }
export type ScriptInput = Input & { kind: "final-script" | "script" };
export type AnalysisInput = ScriptInput | (Input & { kind: "redirect"; source: string });
export const INPUT_LIMIT = 32;
export interface AnalysisState {
	units: ApprovalUnit[];
	pipelines: ShellPipeline[];
	unitLimit: number;
	pending: AnalysisInput[];
	display: string;
	env: Environment;
}

export function pushUnit(state: AnalysisState, unit: ApprovalUnit): void {
	if (state.units.length >= state.unitLimit) throw new IncompletePowerShellAnalysis();
	state.units.push(unit);
}

export function writeRedirect(word: PowerShellRedirectTarget, flow: Flow, depth: number, state: AnalysisState): void {
	const targets = word.value?.startsWith("skill://") ? [word.value]
		: choices(wordValues(word, flow, state.env).flatMap(value => flow.positions.map(([cwd]) => filePath(value, cwd))));
	const temporary = depth === 0 && !flow.uncertain && targets.every(p => p !== undefined && isSystemTemporaryDescendant(p));
	for (const target of targets) {
		pushUnit(state, { action: "write_redirect", ...(depth === 0 && { source: word.source }), remember: false,
			...(target === undefined ? { target: { kind: "command", value: word.source }, analysisFact: "shell.run-opaque-input", analysisNote: "Unresolved redirection target." }
				: { target: { kind: "path", value: target } }), ...(temporary && { effect_scope: "temporary" }) });
	}
}
