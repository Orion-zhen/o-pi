import path from "node:path";
import { FileChangeType } from "vscode-languageserver-protocol";
import type { LspMutationInput, LspDocumentAnalysisInput } from "../file-operations.ts";
import { emptySummary } from "../diagnostics/ledger.ts";

import type { AnalyzedFileIndex, CodeAnalysis } from "../../code-index/types.ts";
import { analyzeLspDocument } from "../analysis/document.ts";
import { AnalysisRequests } from "../analysis/requests.ts";
import { pathToFileUri } from "../protocol/uri.ts";
import { codeAnalysis as runCodeAnalysis, type LspCodeAnalysisInput } from "../analysis/code-analysis.ts";
import {
	beforeDiagnostics as readBeforeDiagnostics,
	didWriteBatch as collectWriteDiagnostics,
	knownDiagnostics as listKnownDiagnostics,
} from "../diagnostics/operations.ts";
import { waitUnlessAborted } from "../analysis/deadline.ts";
import { LspManagerRuntime } from "./runtime.ts";
import type {
	LspMutationBaseline,
	LspDiagnosticsSummary,
	LspStatus,
} from "../types.ts";

export type { LspCodeAnalysisInput } from "../analysis/code-analysis.ts";

export interface LspCodeAnalysisPreparationInput {
	readonly root: string;
	readonly paths: readonly string[];
	readonly signal?: AbortSignal;
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

	documentAnalysis(input: LspDocumentAnalysisInput): Promise<AnalyzedFileIndex | undefined> {
		return this.runtime.withClientOperation(() => this.analyzeDocument(input));
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

	beforeMutation(input: Pick<LspMutationInput, "workspaceRoot" | "filePath">): Promise<LspMutationBaseline | undefined> {
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

	private async analyzeDocument(input: LspDocumentAnalysisInput): Promise<AnalyzedFileIndex | undefined> {
		const workspace = await this.runtime.workspace(input.workspaceRoot);
		if (workspace === undefined) return undefined;
		const route = workspace.routeForFile(input.filePath);
		if (route === undefined) return undefined;
		const requests = new AnalysisRequests(input.signal, workspace.config.request_timeout_ms);
		const started = await requests.run(true, () => workspace.client(route.server));
		if (started.status !== "ok") return undefined;
		const client = started.value;
		const result = await requests.run(client.capabilities()?.documentSymbolProvider, async (options) => {
			const symbols = await client.documentSymbols(input.filePath, input.content, options);
			if (symbols === undefined) return undefined;
			return analyzeLspDocument({
				path: path.relative(input.workspaceRoot, input.filePath).replaceAll(path.sep, "/"), text: input.content,
			}, symbols, pathToFileUri(input.filePath));
		});
		return result.status === "ok" ? result.value : undefined;
	}
}
