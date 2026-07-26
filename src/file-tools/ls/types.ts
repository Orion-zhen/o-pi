export interface LsParams {
	path?: string;
}

export type LsEntryType = "directory" | "file" | "symlink" | "other";

export interface LsEntry {
	name: string;
	path: string;
	type: LsEntryType;
	/** Raw symlink target for display only; it is not followed or authorized here. */
	link_target?: string;
	ignored?: boolean;
	ignore_source?: string;
}

export interface LsSuccess {
	path: string;
	entries: LsEntry[];
	truncated: boolean;
	returned_entries?: number;
	total_entries?: number;
	continuation_hint?: string;
}
