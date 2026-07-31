import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { parsePruneState, PRUNE_STATE } from "../prune.js";
import { PruneSummaryComponent } from "./renderer.js";

export { PruneSummaryComponent } from "./renderer.js";
export {
	getPruneTuiState,
	isToolCallHidden,
	reducePruneTuiState,
	resetPruneTuiState,
	syncPruneTuiState,
	type PruneTuiOperation,
	type PruneTuiState,
} from "./state.js";

export function registerPruneEntryRenderer(pi: Pick<ExtensionAPI, "registerEntryRenderer">): void {
	pi.registerEntryRenderer(PRUNE_STATE, (entry, _options, theme) => {
		if (!parsePruneState(entry.data)) return undefined;
		return new PruneSummaryComponent(entry.id, theme);
	});
}
