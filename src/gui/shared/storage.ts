export type StorageSourceId = "sessions" | "input" | "telemetry" | "reports" | "resources" | "temporary" | "logs";

export interface StorageEntry {
	id: string;
	name: string;
	path: string;
	bytes: number;
	files: number | null;
	modified: number;
	blocked: string | null;
}

export interface StorageGroup {
	id: StorageSourceId | "desktop";
	title: string;
	paths: string[];
	entries: StorageEntry[];
	error: string | null;
}

export interface StorageSnapshot {
	groups: StorageGroup[];
}

