import path from "node:path";

import type { CallRecord, Resource } from "../telemetry/types.js";
import type { NumericSummary, RateSummary } from "./types.js";

export function compare(left: string, right: string): number {
	return left.localeCompare(right, "en");
}

export function frequency(values: readonly string[]): Record<string, number> {
	const counts = new Map<string, number>();
	for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
	return Object.fromEntries([...counts].sort(([left], [right]) => compare(left, right)));
}

export function numericSummary(values: readonly number[]): NumericSummary {
	const [min, ...remaining] = [...values].sort((left, right) => left - right);
	if (min === undefined) return { samples: 0 };
	let max = min;
	for (const value of remaining) max = value;
	return {
		samples: values.length,
		min,
		max,
		mean: values.reduce((sum, value) => sum + value, 0) / values.length,
		p50: percentile(min, remaining, 0.5),
		p95: percentile(min, remaining, 0.95),
	};
}

export function rateSummary(numerator: number, samples: number): RateSummary {
	return { numerator, samples, ...(samples === 0 ? {} : { value: numerator / samples }) };
}

export function ratio(numerator: number, denominator: number): number {
	return denominator === 0 ? 0 : numerator / denominator;
}

type NonEmptyArray<T> = [T, ...T[]];

export function callsByRun(calls: readonly CallRecord[]): Map<string, NonEmptyArray<CallRecord>> {
	const result = new Map<string, NonEmptyArray<CallRecord>>();
	for (const call of calls) {
		const values = result.get(call.run_id);
		if (values === undefined) result.set(call.run_id, [call]);
		else values.push(call);
	}
	for (const values of result.values()) values.sort((left, right) => left.call_index - right.call_index || compare(left.at, right.at));
	return result;
}

export function sameBatch(left: CallRecord, right: CallRecord): boolean {
	return left.batch !== undefined && right.batch !== undefined && left.batch.id === right.batch.id;
}

export function withinMillis(left: CallRecord, right: CallRecord, milliseconds: number): boolean {
	return Math.abs(Date.parse(right.at) - Date.parse(left.at)) <= milliseconds;
}

export function resourceKey(resource: Resource, cwd: string): string {
	return resource.kind === "url" ? `url:${resource.value}` : normalizeResource(resource.value, cwd);
}

export function requireRunCwd(cwdByRun: ReadonlyMap<string, string>, runId: string): string {
	const cwd = cwdByRun.get(runId);
	if (cwd === undefined) throw new Error(`Missing cwd for telemetry run "${runId}".`);
	return cwd;
}

function normalizeResource(value: string, cwd: string): string {
	return path.normalize(path.isAbsolute(value) ? value : path.resolve(cwd, value));
}

function percentile(first: number, remaining: readonly number[], quantile: number): number {
	const targetIndex = Math.ceil(quantile * (remaining.length + 1)) - 1;
	let result = first;
	for (const [index, value] of remaining.entries()) {
		if (index + 1 > targetIndex) break;
		result = value;
	}
	return result;
}
