import type { CodeAnalysisStatus, SourceRange } from "./types.ts";

/** 已校验快照的位置。行列为 1-based，列按 UTF-16 计数。 */
export interface CodeRelationLocation {
	readonly path: string;
	readonly hash: string;
	readonly range: SourceRange;
	readonly line: number;
	readonly column: number;
	readonly unitId?: string;
}

/** 保留服务器返回的全部候选，包括当前 scope 内无法验证的目标。 */
export type CodeRelationTarget = {
	readonly uri: string;
	readonly range: {
		readonly start: { readonly line: number; readonly character: number };
		readonly end: { readonly line: number; readonly character: number };
	};
} & (
	| { readonly status: "ok"; readonly location: CodeRelationLocation; readonly binding: "callable" | "indirect" }
	| { readonly status: "unavailable" }
);

export interface CodeCallRelation {
	readonly kind: "call";
	readonly source: "hierarchy" | "definition" | "syntax";
	/** 调用层次可能不提供调用位置，但仍保留 caller/target 关系。 */
	readonly site?: CodeRelationLocation;
	readonly caller?: CodeRelationLocation;
	readonly targets: readonly CodeRelationTarget[];
	readonly status: CodeAnalysisStatus;
	readonly resolution: "resolved" | "ambiguous" | "indirect" | "unknown";
}

export interface CodeReferenceRelation {
	readonly kind: "reference";
	readonly source: "references";
	readonly site: CodeRelationLocation;
	readonly target: CodeRelationLocation;
}

export type CodeRelation = CodeCallRelation | CodeReferenceRelation;
