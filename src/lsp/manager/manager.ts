import path from "node:path";
import { FileChangeType } from "vscode-languageserver-protocol";
import type { LspMutationInput, LspReadInput } from "../file-operations.js";
import { emptySummary } from "../diagnostics/ledger.js";

import type { CodeAnalysis } from "../../code-index/types.js";
import { codeAnalysis as runCodeAnalysis, type LspCodeAnalysisInput } from "../analysis/code-analysis.js";
import {
	beforeDiagnostics as readBeforeDiagnostics,
	didWriteBatch as collectWriteDiagnostics,
	knownDiagnostics as listKnownDiagnostics,
} from "../diagnostics/operations.js";
import { waitUnlessAborted } from "../analysis/deadline.js";
import { LspManagerRuntime } from "./runtime.js";
import { findEnclosingSymbol, remainingSymbols } from "../analysis/symbols.js";
import type {
	LspDiagnosticSnapshot,
	LspDiagnosticsSummary,
	LspEnclosingSymbol,
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

	read(input: LspReadInput): Promise<ReadEnhancement | undefined> {
		return this.runtime.withClientOperation(() => this.readEnhancementOperation(
			input.workspaceRoot, input.filePath, input.content, input,
			{ outline: input.truncated && !input.partial, enclosing: input.partial },
		));
	}

	codeAnalysis(input: LspCodeAnalysisInput): Promise<CodeAnalysis | undefined> {
		return this.runtime.withClientOperation(async () => {
			const workspace = await this.runtime.workspace(input.root);
			return workspace === undefined ? undefined : runCodeAnalysis(workspace, input);
		});
	}

	prepareCodeAnalysis(input: LspCodeAnalysisPreparationInput): Promise<void> {
		return this.runtime.withClientOperation(async () => {
			const workspace = await this.runtime.workspace(input.root);
			if (workspace === undefined || input.signal?.aborted === true) return;
			const servers = workspace.serversForPaths(input.paths);
			await Promise.all(servers.map(async (server) => {
				if (input.signal === undefined) {
					await workspace.client(server);
					return;
				}
				await waitUnlessAborted(workspace.client(server), input.signal);
			}));
		});
	}

	beforeMutation(input: Pick<LspMutationInput, "workspaceRoot" | "filePath">): Promise<LspDiagnosticSnapshot | undefined> {
		return readBeforeDiagnostics(this.runtime, input.workspaceRoot, input.filePath);
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
				const workspace = await this.runtime.workspace(root);
				if (workspace === undefined) return;
				await Promise.all(workspace.startedClients().map((client) => client.didChangeWatchedFiles(grouped)));
			}));
		});
	}

	async afterMutation(input: LspMutationInput): Promise<LspDiagnosticsSummary | undefined> {
		return (await this.afterMutationBatch([input]))[0];
	}

	/** 文件已提交。通知失败不能阻止诊断，诊断失败也不能改变提交结果。 */
	async afterMutationBatch(inputs: readonly LspMutationInput[]): Promise<readonly (LspDiagnosticsSummary | undefined)[]> {
		try {
			await this.didChangeWatchedFiles(inputs.map((input) => ({
				root: input.workspaceRoot,
				filePath: input.filePath,
				type: input.created ? FileChangeType.Created : FileChangeType.Changed,
			})));
		} catch {
			// watched-file 通知和诊断是独立的增强步骤。
		}
		try {
			return await collectWriteDiagnostics(this.runtime, inputs.map((input) => ({
				root: input.workspaceRoot,
				filePath: input.filePath,
				text: input.content,
				...(input.changed_ranges === undefined ? {} : { changed_ranges: input.changed_ranges }),
				...(input.baseline === undefined ? {} : { baseline: input.baseline }),
			})));
		} catch {
			return inputs.map(() => emptySummary("unavailable"));
		}
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
		const workspace = await this.runtime.workspace(root);
		if (workspace === undefined) return undefined;
		const config = workspace.config;
		const wantsOutline = options.outline
			&& !options.enclosing
			&& config.read.outline
			&& config.read.max_symbols > 0;
		if (!wantsOutline && !options.enclosing) return undefined;
		const route = workspace.routeForFile(filePath);
		if (route === undefined) return undefined;
		const client = await workspace.client(route.server);
		if (client === undefined) return undefined;
		const symbols = await client.documentSymbols(filePath, text);
		if (symbols === undefined) return undefined;
		const result: ReadEnhancement = {};
		if (wantsOutline) {
			const remaining = remainingSymbols(symbols, range.startLine, range.endLine, config.read.max_symbols);
			if (remaining.length > 0) result.remaining_symbols = remaining;
		}
		if (options.enclosing) {
			const enclosing = findEnclosingSymbol(symbols, range.startLine, range.endLine);
			if (enclosing !== undefined) result.enclosing_symbol = enclosing;
		}
		return Object.keys(result).length === 0 ? undefined : result;
	}
}
