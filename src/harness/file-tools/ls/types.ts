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

interface LsSuccessBase {
	path: string;
	entries: LsEntry[];
}

export interface LsCompleteSuccess extends LsSuccessBase {
	truncated: false;
}

export interface LsTruncatedSuccess extends LsSuccessBase {
	truncated: true;
	returned_entries: number;
	total_entries: number;
	continuation_hint: string;
}

export type LsSuccess = LsCompleteSuccess | LsTruncatedSuccess;
