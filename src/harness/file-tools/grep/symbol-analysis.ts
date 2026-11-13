import type { CodeAnalysisCoverage, CodeAnalysisTarget } from "../../code-index/types.ts";
import { fail, type FailedResult } from "../shared/result.ts";
import type { GrepCommandContext } from "./command.ts";
import { GrepDocuments } from "./documents.ts";
import type { QueryPlan } from "./query-plan.ts";
import type { SemanticRegionizedFile } from "./regionizer.ts";
import type { TextScanResult } from "./text-scanner.ts";

interface SymbolAnalysisAttempt {
	readonly files: readonly SemanticRegionizedFile[];
	readonly coverage: readonly CodeAnalysisCoverage[];
	readonly syntaxPaths: readonly string[];
}

/** 可选增强只提交分析事实，正文与语法任务由本次搜索统一拥有。 */
export async function analyzeSymbols(
	plan: QueryPlan,
	documents: GrepDocuments,
	scan: TextScanResult,
	analysisPaths: readonly string[],
	context: GrepCommandContext,
): Promise<SymbolAnalysisAttempt | FailedResult> {
	const empty: SymbolAnalysisAttempt = { files: [], coverage: [], syntaxPaths: analysisPaths };
	if (context.analyzeCode === undefined) return empty;
	const targets = codeAnalysisTargets(scan, analysisPaths).filter((target) => documents.eligible(target.path));
	const unavailable: SymbolAnalysisAttempt = {
		...empty,
		coverage: targets.map((target) => ({ path: target.path, symbols: "unavailable" })),
	};
	let analysis;
	try {
		analysis = await context.analyzeCode({
			query: plan.targetQuery.length === 0 ? plan.query : plan.targetQuery,
			targets,
			allowRelated: scan.totalHits === 0,
			limit: context.limits.grep_result_limit,
			async load(path) {
				const loaded = await documents.load(path);
				return loaded.ok ? loaded.value : undefined;
			},
			syntax: (document, signal) => documents.syntax(document, signal),
			signal: context.operation.signal,
		});
	} catch {
		return context.operation.signal.aborted ? aborted() : unavailable;
	}
	if (context.operation.signal.aborted) return aborted();
	if (analysis === undefined) return unavailable;
	const files: SemanticRegionizedFile[] = [];
	const syntaxPaths = new Set(analysisPaths);
	for (const { coverage, file } of analysis.results) {
		if (file === undefined) {
			// 成功空结果和预算外候选不扩大零命中的语法搜索范围。
			if (scan.totalHits === 0 && (coverage.symbols === "ok" || coverage.symbols === "skipped")) syntaxPaths.delete(coverage.path);
			continue;
		}
		const loaded = await documents.load(coverage.path);
		if (!loaded.ok || loaded.value === undefined) continue;
		files.push({ document: loaded.value, analysis: file.analysis, selectedIds: file.selectedIds });
		syntaxPaths.delete(coverage.path);
	}
	return { files, coverage: analysis.results.map((result) => result.coverage), syntaxPaths: analysisPaths.filter((path) => syntaxPaths.has(path)) };
}

function codeAnalysisTargets(scan: TextScanResult, analysisPaths: readonly string[]): CodeAnalysisTarget[] {
	const ranges = new Map<string, Array<{ startByte: number; endByte: number }>>();
	for (const hit of scan.hits) {
		const grouped = ranges.get(hit.path);
		const range = { startByte: hit.byteStart, endByte: hit.byteEnd };
		if (grouped === undefined) ranges.set(hit.path, [range]);
		else grouped.push(range);
	}
	const paths = scan.totalHits === 0 ? analysisPaths : [...ranges.keys()];
	return paths.map((path) => ({ path, ranges: ranges.get(path) ?? [] }));
}

function aborted(): FailedResult {
	return fail("OPERATION_ABORTED", "grep was aborted.");
}
