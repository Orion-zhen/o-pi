import type { ObservationEntry } from "./observation-store.js";

export const FILE_TOOLS_OBSERVATION_STATE = "o-pi.file-tools.observations.v1";

export interface PersistedObservationState {
	readonly observations: readonly ObservationEntry[];
}

export interface ObservationStateBranchEntry {
	readonly type: string;
	readonly customType?: string;
	readonly data?: unknown;
}

export function createPersistedObservationState(
	observations: readonly ObservationEntry[],
): PersistedObservationState {
	return {
		observations: observations.map(copyObservation),
	};
}

export function readPersistedObservationState(
	entries: readonly ObservationStateBranchEntry[],
): PersistedObservationState | undefined {
	let state: PersistedObservationState | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== FILE_TOOLS_OBSERVATION_STATE) continue;
		const parsed = parseState(entry.data);
		if (parsed !== undefined) state = parsed;
	}
	return state;
}

function parseState(value: unknown): PersistedObservationState | undefined {
	if (!isRecord(value) || !Array.isArray(value["observations"])) return undefined;
	const observations: ObservationEntry[] = [];
	for (const candidate of value["observations"]) {
		if (!isRecord(candidate)) return undefined;
		const canonicalPath = candidate["canonicalPath"];
		const version = candidate["version"];
		if (
			typeof canonicalPath !== "string"
			|| canonicalPath.length === 0
			|| !isRecord(version)
			|| typeof version["hash"] !== "string"
			|| !/^sha256:[0-9a-f]{64}$/u.test(version["hash"])
			|| typeof version["sizeBytes"] !== "number"
			|| !Number.isSafeInteger(version["sizeBytes"])
			|| version["sizeBytes"] < 0
		) return undefined;
		observations.push({
			canonicalPath,
			version: { hash: version["hash"], sizeBytes: version["sizeBytes"] },
		});
	}
	return { observations };
}

function copyObservation(observation: ObservationEntry): ObservationEntry {
	return {
		canonicalPath: observation.canonicalPath,
		version: {
			hash: observation.version.hash,
			sizeBytes: observation.version.sizeBytes,
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
