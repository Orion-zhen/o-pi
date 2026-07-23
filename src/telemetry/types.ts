import type { RepairFanout, RepairOperation, ToolArgumentStatus } from "../tool-repair/types.js";

export type FieldValue = string | number | boolean | null | string[];
export type Fields = Record<string, FieldValue>;

export interface Resource {
	kind: string;
	value: string;
	start_line?: number;
	end_line?: number;
}

export interface Candidate extends Resource {
	rank: number;
	group?: string;
	sources: string[];
}

/** Tool-owned, payload-free facts used by focused offline analyzers. */
export interface TelemetryFacts {
	fields?: Fields;
	targets?: Resource[];
	candidates?: Candidate[];
}

export interface TelemetryResult<TDetails> {
	details: TDetails;
}

export interface ToolTelemetry<TParams, TDetails> {
	input?(params: TParams): TelemetryFacts;
	result?(params: TParams, result: TelemetryResult<TDetails>): TelemetryFacts;
}

export interface GitRevision {
	root?: string;
	commit?: string;
	dirty: boolean;
	dirty_diff_hash?: string;
}

interface TelemetryBaseRecord {
	type: "run" | "call";
	run_id: string;
	at: string;
}

export interface RunRecord extends TelemetryBaseRecord {
	type: "run";
	session_id: string;
	reason: "startup" | "reload" | "new" | "resume" | "fork";
	cwd: string;
	git?: GitRevision;
}

export interface CallBatch {
	id: string;
	size: number;
	index: number;
}

export interface CallRepair {
	status: ToolArgumentStatus;
	operations: RepairOperation[];
	fanout?: RepairFanout;
}

export interface CallError {
	code?: string;
	name?: string;
}

export interface CallRecord extends TelemetryBaseRecord, TelemetryFacts {
	type: "call";
	call_id: string;
	call_index: number;
	turn_index?: number;
	tool: string;
	definition_hash?: string;
	model?: { provider: string; id: string };
	thinking?: string;
	repo_map?: { enabled: boolean; freshness?: string; map_id?: string };
	started_at: string;
	ended_at: string;
	duration_ms: number;
	status: "success" | "error";
	error?: CallError;
	output_chars?: number;
	output_lines?: number;
	truncated?: boolean;
	repair?: CallRepair;
	batch?: CallBatch;
}

export type TelemetryRecord = RunRecord | CallRecord;
