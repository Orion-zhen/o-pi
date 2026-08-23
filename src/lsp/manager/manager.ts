import path from "node:path";
import type { FileChangeType } from "vscode-languageserver-protocol";

import type { CodeAnalysis } from "../../code-index/types.js";
import { codeAnalysis as runCodeAnalysis, type LspCodeAnalysisInput } from "../analysis/code-analysis.js";
import {
	beforeDiagnostics as readBeforeDiagnostics,
	didWriteBatch as collectWriteDiagnostics,
	knownDiagnostics as listKnownDiagnostics,
	type LspWriteInput,
} from "../diagnostics/operations.js";
import { waitUnlessAborted } from "../analysis/deadline.js";
import { isExcludedRoot, LspManagerRuntime } from "./runtime.js";
import { findEnclosingSymbol, remainingSymbols } from "../analysis/symbols.js";
import type {
	LspDiagnosticSnapshot,
	LspDiagnosticsSummary,
	LspEnclosingSymbol,
	LspLineRange,
	LspRemainingSymbol,
	LspStatus,
} from "../types.js";

export type { LspCodeAnalysisInput } from "../analysis/code-analysis.js";

export interface LspCodeAnalysisPreparationInput {
	readonly root: string;
	readonly paths: readonly string[];
	readonly signal?: AbortSignal;
}

export interface ReadEnhancement {
	/** 整文件截断且可见部分不足以覆盖顶层结构时的导航回退。 */
	remaining_symbols?: LspRemainingSymbol[];
	/** partial range 所属的最小包围 symbol。 */
	enclosing_symbol?: LspEnclosingSymbol;
}

/** 进程内 LSP 管理器：负责对外协调各个专用服务。 */
export class LspManager {
	private readonly runtime = new LspManagerRuntime();

	status(root = process.cwd()): Promise<LspStatus> {
		return this.runtime.status(root);
	}

	reload(): Promise<void> {
		return this.runtime.reload();
	}

	readEnhancement(
		root: string,
		filePath: string,
		text: string,
		range: { startLine: number; endLine: number },
		options: { outline: boolean; enclosing: boolean },
	): Promise<ReadEnhancement | undefined> {
		return this.runtime.withClientOperation(() => this.readEnhancementOperation(root, filePath, text, range, options));
	}

	codeAnalysis(input: LspCodeAnalysisInput): Promise<CodeAnalysis | undefined> {
		return this.runtime.withClientOperation(() => runCodeAnalysis(this.runtime, input));
	}

	prepareCodeAnalysis(input: LspCodeAnalysisPreparationInput): Promise<void> {
		return this.runtime.withClientOperation(async () => {
			const config = await this.runtime.enabledConfig(input.root);
			if (
				config === undefined
				|| isExcludedRoot(input.root, config.config.exclude_paths)
				|| input.signal?.aborted === true
			) return;
			const servers = this.runtime.serversForPaths(input.root, input.paths);
			await Promise.all(servers.map(async (server) => {
				if (input.signal === undefined) {
					await this.runtime.clientForServer(input.root, server);
					return;
				}
				await waitUnlessAborted(this.runtime.clientForServer(input.root, server), input.signal);
			}));
		});
	}

	beforeDiagnostics(root: string, filePath: string): Promise<LspDiagnosticSnapshot | undefined> {
		return readBeforeDiagnostics(this.runtime, root, filePath);
	}

	didChangeWatchedFile(root: string, filePath: string, type: FileChangeType): Promise<void> {
		return this.didChangeWatchedFiles([{ root, filePath, type }]);
	}

	didChangeWatchedFiles(
		changes: readonly { root: string; filePath: string; type: FileChangeType }[],
	): Promise<void> {
		return this.runtime.withClientOperation(async () => {
			const byRoot = new Map<string, Array<{ filePath: string; type: FileChangeType }>>();
			for (const change of changes) {
				const root = path.resolve(change.root);
				const group = byRoot.get(root);
				const item = { filePath: change.filePath, type: change.type };
				if (group === undefined) byRoot.set(root, [item]);
				else group.push(item);
			}
			await Promise.all(Array.from(byRoot, async ([root, grouped]) => {
				const config = await this.runtime.enabledConfig(root);
				if (config === undefined || isExcludedRoot(root, config.config.exclude_paths)) return;
				await Promise.all(this.runtime.clientsForRoot(root).map((client) => client.didChangeWatchedFiles(grouped)));
			}));
		});
	}

	async didWrite(
		root: string,
		filePath: string,
		text: string,
		baseline?: LspDiagnosticSnapshot,
		changed_ranges?: readonly LspLineRange[],
	): Promise<LspDiagnosticsSummary | undefined> {
		return (await this.didWriteBatch([{
			root,
			filePath,
			text,
			...(changed_ranges === undefined ? {} : { changed_ranges }),
			...(baseline === undefined ? {} : { baseline }),
		}]))[0];
	}

	didWriteBatch(writes: readonly LspWriteInput[]): Promise<readonly (LspDiagnosticsSummary | undefined)[]> {
		return collectWriteDiagnostics(this.runtime, writes);
	}

	knownDiagnostics(root: string, filePath?: string): Promise<Array<{ path: string; items: LspDiagnosticsSummary["items"] }>> {
		return listKnownDiagnostics(this.runtime, root, filePath);
	}

	private async readEnhancementOperation(
		root: string,
		filePath: string,
		text: string,
		range: { startLine: number; endLine: number },
		options: { outline: boolean; enclosing: boolean },
	): Promise<ReadEnhancement | undefined> {
		const config = await this.runtime.enabledConfig(root);
		if (config === undefined || isExcludedRoot(root, config.config.exclude_paths)) return undefined;
		const wantsOutline = options.outline
			&& !options.enclosing
			&& config.config.read.outline
			&& config.config.read.max_symbols > 0;
		if (!wantsOutline && !options.enclosing) return undefined;
		const client = await this.runtime.clientForFile(root, filePath);
		if (client === undefined) return undefined;
		const symbols = await client.documentSymbols(filePath, text);
		if (symbols === undefined) return undefined;
		const result: ReadEnhancement = {};
		if (wantsOutline) {
			const remaining = remainingSymbols(symbols, range.startLine, range.endLine, config.config.read.max_symbols);
			if (remaining.length > 0) result.remaining_symbols = remaining;
		}
		if (options.enclosing) {
			const enclosing = findEnclosingSymbol(symbols, range.startLine, range.endLine);
			if (enclosing !== undefined) result.enclosing_symbol = enclosing;
		}
		return Object.keys(result).length === 0 ? undefined : result;
	}
}
