import { languageFromPath } from "../../syntax-tree/grammars.ts";
import type { CodeAnalysisCoverage, CodeAnalysisTarget, CodeAnalysisInput } from "../../code-index/types.ts";
import type { TextContent } from "../../filesystem/contracts/content.ts";
import { fail, type FailedResult } from "../shared/result.ts";
import type { GrepCommandContext } from "./command.ts";
import type { ScopeInventory } from "./inventory.ts";
import type { QueryPlan } from "./query-plan.ts";
import type { SemanticRegionizedFile } from "./regionizer.ts";
import type { TextScanResult } from "./text-scanner.ts";

interface SymbolAnalysisAttempt {
	readonly loaded: ReadonlyMap<string, TextContent>;
	readonly files: readonly SemanticRegionizedFile[];
	readonly coverage: readonly CodeAnalysisCoverage[];
	readonly syntaxPaths: readonly string[];
}

/** 快照绑定加载和逐文件接纳。失败文件留给语法分析，不撤销其他文件。 */
export async function analyzeSymbols(
	plan: QueryPlan,
	inventory: ScopeInventory,
	scan: TextScanResult,
	analysisPaths: readonly string[],
	context: GrepCommandContext,
	syntax: CodeAnalysisInput["syntax"],
): Promise<SymbolAnalysisAttempt | FailedResult> {
	const loaded = new Map<string, TextContent>(scan.contents);
	const empty: SymbolAnalysisAttempt = { loaded, files: [], coverage: [], syntaxPaths: analysisPaths };
	if (context.analyzeCode === undefined) return empty;
	const byPath = new Map(inventory.files.map((file) => [file.path, file]));
	const targets = codeAnalysisTargets(scan, analysisPaths, byPath, context.limits.grep_ast_max_file_bytes);
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
			syntax,
			async load(path) {
				const cached = loaded.get(path);
				if (cached !== undefined) {
					return hasBareCr(cached.text) ? undefined : { path, text: cached.text, hash: cached.hash };
				}
				const file = byPath.get(path);
				if (file === undefined || file.snapshot.sizeBytes > context.limits.grep_ast_max_file_bytes) return undefined;
				const content = await context.filesystem.content.readText(file.ref, {
					maxBytes: context.limits.grep_ast_max_file_bytes,
					expectedSnapshot: file.snapshot,
				});
				if (!content.ok) return undefined;
				loaded.set(path, content.value);
				if (hasBareCr(content.value.text)) return undefined;
				return { path, text: content.value.text, hash: content.value.hash };
			},
			...(context.operation.signal === undefined ? {} : { signal: context.operation.signal }),
		});
	} catch {
		return context.operation.signal?.aborted === true ? aborted() : unavailable;
	}
	if (context.operation.signal?.aborted === true) return aborted();
	if (analysis === undefined) return unavailable;
	const coverage = new Map(unavailable.coverage.map((item) => [item.path, item]));
	const files: SemanticRegionizedFile[] = [];
	const syntaxPaths = new Set(analysisPaths);
	for (const { coverage: status, file: analyzed } of analysis.results) {
		if (!coverage.has(status.path)) continue;
		coverage.set(status.path, status);
		if (analyzed === undefined) {
			// 成功空结果和预算外候选不扩大零命中的语法搜索范围。
			if (scan.totalHits === 0 && (status.symbols === "ok" || status.symbols === "skipped")) syntaxPaths.delete(status.path);
			continue;
		}
		const { document, analysis: fileAnalysis, selectedIds } = analyzed;
		const file = byPath.get(status.path);
		const content = loaded.get(status.path);
		if (
			file === undefined || content === undefined || document.path !== status.path
			|| document.hash !== content.hash || document.text !== content.text
			|| fileAnalysis.path !== document.path || fileAnalysis.status !== "parsed"
			|| fileAnalysis.units.some((unit) => unit.path !== document.path
				|| !Number.isSafeInteger(unit.startByte) || !Number.isSafeInteger(unit.endByte)
				|| unit.startByte < 0 || unit.endByte < unit.startByte || unit.endByte > content.sizeBytes - (content.hasBom ? 3 : 0))
		) {
			coverage.set(status.path, { ...status, symbols: "unavailable" });
			continue;
		}
		files.push({ file, content, analysis: fileAnalysis, selectedIds });
		syntaxPaths.delete(status.path);
	}
	return { loaded, files, coverage: [...coverage.values()], syntaxPaths: analysisPaths.filter((path) => syntaxPaths.has(path)) };
}

function codeAnalysisTargets(
	scan: TextScanResult,
	analysisPaths: readonly string[],
	files: ReadonlyMap<string, ScopeInventory["files"][number]>,
	astMaxFileBytes: number,
): CodeAnalysisTarget[] {
	const ranges = new Map<string, Array<{ startByte: number; endByte: number }>>();
	for (const hit of scan.hits) {
		const grouped = ranges.get(hit.path);
		const range = { startByte: hit.byteStart, endByte: hit.byteEnd };
		if (grouped === undefined) ranges.set(hit.path, [range]);
		else grouped.push(range);
	}
	const paths = scan.totalHits === 0 ? analysisPaths : [...ranges.keys()];
	return paths.flatMap((path) => {
		const file = files.get(path);
		if (file === undefined || file.snapshot.sizeBytes > astMaxFileBytes || languageFromPath(file.path) === "text") return [];
		return [{ path, ranges: ranges.get(path) ?? [] }];
	});
}

function hasBareCr(text: string): boolean {
	return /\r(?!\n)/u.test(text);
}

function aborted(): FailedResult {
	return fail("OPERATION_ABORTED", "grep was aborted.");
}
