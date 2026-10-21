import type { CallRecord } from "../../telemetry/types.ts";
import { resourceKey } from "../shared.ts";
import type { CandidateAttribution, NormalizedCandidate } from "./candidate-observations.ts";

/** 每个文件及搜索调用只保留最近的读取，修改时直接关联。 */
export function markReadThenMutationProductive(calls: readonly CallRecord[], attributions: CandidateAttribution[], cwd: string): void {
	const byConsumer = new Map(attributions.map((item) => [item.consumer, item]));
	const byFile = new Map<string, CandidateAttribution>();
	const byCandidate = new Map<NormalizedCandidate, CandidateAttribution>();
	for (let start = 0; start < calls.length;) {
		let end = start + 1;
		while (end < calls.length && calls[end]?.call_index === calls[start]?.call_index) end += 1;
		for (let index = start; index < end; index += 1) {
			const mutation = calls[index];
			if (mutation === undefined || mutation.status !== "success" || (mutation.tool !== "edit" && mutation.tool !== "write")) continue;
			const direct = byConsumer.get(mutation);
			let selected = direct === undefined ? undefined : byCandidate.get(direct.file_candidate);
			if (direct === undefined) {
				for (const target of mutation.targets ?? []) {
					const candidate = byFile.get(resourceKey(target, cwd));
					if (candidate !== undefined && (selected === undefined || candidate.consumer.call_index > selected.consumer.call_index)) selected = candidate;
				}
			}
			if (selected !== undefined) selected.productive = true;
		}
		for (let index = start; index < end; index += 1) {
			const call = calls[index];
			const item = call === undefined ? undefined : byConsumer.get(call);
			if (item?.inspection !== true) continue;
			keepLatest(byCandidate, item.file_candidate, item);
			keepLatest(byFile, item.file_candidate.file_key, item);
		}
		start = end;
	}
}

function keepLatest<Key>(values: Map<Key, CandidateAttribution>, key: Key, value: CandidateAttribution): void {
	const current = values.get(key);
	if (current === undefined || current.consumer.call_index < value.consumer.call_index) values.set(key, value);
}
