import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { findSkillCandidate, loadSkill } from "./loader.js";
import { hasCurrentDisclosure } from "./state.js";
import { SKILL_CONTEXT_ENTRY, type SkillCandidate, type SkillLoadEntry, type SkillLoadResult } from "./types.js";

interface ExecuteSkillLoadInputBase {
	name: string;
	candidates: SkillCandidate[];
	branch: SessionEntry[];
}

export type ExecuteSkillLoadInput =
	| (ExecuteSkillLoadInputBase & {
		loadedBy: "agent";
		/** Agent tool calls still represented in the effective model context. */
		visibleToolCallIds: ReadonlySet<string>;
		/** The tool transaction that will contain this disclosure. */
		toolCallId: string;
	})
	| (ExecuteSkillLoadInputBase & {
		loadedBy: "manual";
		/** Agent disclosures still represented in the effective model context. */
		visibleToolCallIds?: ReadonlySet<string>;
	});

interface SkillEntryWriter {
	appendEntry(customType: string, data: SkillLoadEntry): void;
}

export class SkillLoadError extends Error {
	constructor(
		readonly code: "SKILL_NOT_FOUND" | "SKILL_NOT_LOADABLE" | "SKILL_RESOURCE_USE_READ",
		message: string,
	) {
		super(message);
		this.name = "SkillLoadError";
	}
}

/** 模型与手动加载共用执行器，统一处理发现、权限、校验、去重和分支记录。 */
export async function executeSkillLoad(
	pi: SkillEntryWriter,
	input: ExecuteSkillLoadInput,
): Promise<SkillLoadResult> {
	const candidate = findSkillCandidate(input.name, input.candidates);
	if (candidate === undefined) throw new SkillLoadError("SKILL_NOT_FOUND", `skill "${input.name}" was not found.`);
	if (input.loadedBy === "agent" && candidate.disableModelInvocation !== false) {
		throw new SkillLoadError("SKILL_NOT_LOADABLE", `skill "${candidate.name}" disables model invocation.`);
	}

	const loaded = await loadSkill(candidate);

	const candidateEntry: SkillLoadEntry = {
		name: loaded.name,
		path: loaded.path,
		root: loaded.root,
		contentHash: loaded.contentHash,
		scope: loaded.scope,
		loadedBy: input.loadedBy,
		loadedAt: new Date().toISOString(),
		...(input.loadedBy === "agent" ? { toolCallId: input.toolCallId } : {}),
	};
	const deduplicated = hasCurrentDisclosure(
		input.branch,
		candidateEntry,
		input.visibleToolCallIds,
	);
	if (!deduplicated) {
		pi.appendEntry(SKILL_CONTEXT_ENTRY, candidateEntry);
	}

	return {
		content: formatSkillDisclosure(loaded.name, deduplicated ? "" : loaded.body),
		details: {
			name: loaded.name,
			root: `skill://${loaded.name}`,
			contentHash: loaded.contentHash,
			scope: loaded.scope,
			loadedBy: input.loadedBy,
			deduplicated,
			chars: deduplicated ? 0 : loaded.body.length,
		},
	};
}

export function formatSkillDisclosure(name: string, body: string): string {
	const boundary = `<invoked_skill root="skill://${name}"/>`;
	return body.length === 0 ? boundary : `${boundary}\n\n${body}`;
}
