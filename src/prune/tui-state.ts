import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { parsePruneState, PRUNE_STATE, type PruneCheckpointState, type PruneState } from "./prune.js";

export type PruneTuiOperation = PruneState["operation"];

export interface PruneTuiState {
	readonly hiddenToolCallIds: ReadonlySet<string>;
	readonly latestCheckpointEntryId: string | undefined;
	readonly operation: PruneTuiOperation | undefined;
	readonly changedToolCalls: number;
	readonly hiddenToolCalls: number;
}

let currentState = emptyPruneTuiState();

export function reducePruneTuiState(entries: readonly SessionEntry[]): PruneTuiState {
	const pruneEntries = new Map<string, PruneCheckpointState>();
	let latestCheckpointEntryId: string | undefined;
	let latestState: PruneState | undefined;

	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== PRUNE_STATE) continue;
		const state = parsePruneState(entry.data);
		if (!state) continue;
		if (state.operation === "prune") pruneEntries.set(entry.id, state);
		latestCheckpointEntryId = entry.id;
		latestState = state;
	}

	if (!latestState || latestCheckpointEntryId === undefined) return emptyPruneTuiState();
	const hiddenToolCallIds = new Set(latestState.toolCallIds);
	return {
		hiddenToolCallIds,
		latestCheckpointEntryId,
		operation: latestState.operation,
		changedToolCalls: countChangedToolCalls(latestState, pruneEntries),
		hiddenToolCalls: hiddenToolCallIds.size,
	};
}

export function syncPruneTuiState(entries: readonly SessionEntry[]): PruneTuiState {
	currentState = reducePruneTuiState(entries);
	return currentState;
}

export function resetPruneTuiState(): void {
	currentState = emptyPruneTuiState();
}

export function getPruneTuiState(): PruneTuiState {
	return currentState;
}

export function isToolCallHidden(toolCallId: string): boolean {
	return currentState.hiddenToolCallIds.has(toolCallId);
}

function countChangedToolCalls(
	state: PruneState,
	pruneEntries: ReadonlyMap<string, PruneCheckpointState>,
): number {
	if (state.operation === "prune") {
		const previous = new Set(state.previousToolCallIds);
		return state.toolCallIds.filter((id) => !previous.has(id)).length;
	}
	const restored = pruneEntries.get(state.restoredEntryId);
	if (!restored) return 0;
	const previous = new Set(restored.previousToolCallIds);
	return restored.toolCallIds.filter((id) => !previous.has(id)).length;
}

function emptyPruneTuiState(): PruneTuiState {
	return {
		hiddenToolCallIds: new Set(),
		latestCheckpointEntryId: undefined,
		operation: undefined,
		changedToolCalls: 0,
		hiddenToolCalls: 0,
	};
}

