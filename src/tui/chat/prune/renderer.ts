import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";

import { getPruneTuiState } from "./state.js";

export class PruneSummaryComponent implements Component {
	constructor(
		private readonly entryId: string,
		private readonly theme: Pick<Theme, "fg">,
	) {}

	render(width: number): string[] {
		const state = getPruneTuiState();
		if (state.latestCheckpointEntryId !== this.entryId || state.operation === undefined || width <= 0) return [];
		const action = state.operation === "prune"
			? `hid ${state.changedToolCalls} tool calls`
			: `restored ${state.changedToolCalls} tool calls`;
		const summary = this.theme.fg("dim", `prune: ${action}; ${state.hiddenToolCalls} hidden`);
		return [truncateToWidth(summary, width)];
	}

	invalidate(): void {}
}
