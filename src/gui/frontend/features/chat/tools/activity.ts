import type { GuiNestedCalls, GuiToolOutput, ToolState } from "../../../../shared/messages/types.ts";

export interface ToolActivity {
	id: string;
	name: string;
	args: unknown;
	state: ToolState;
	output: GuiToolOutput | undefined;
	nestedCalls?: GuiNestedCalls;
	durationMs?: number;
}

export function sameToolActivity(before: ToolActivity, after: ToolActivity): boolean {
	return before.id === after.id && before.name === after.name && before.state === after.state
		&& before.args === after.args && before.output === after.output && before.nestedCalls === after.nestedCalls && before.durationMs === after.durationMs;
}
