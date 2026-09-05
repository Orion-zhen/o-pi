import pLimit from "p-limit";
import {
	DocumentDiagnosticRequest,
	type Diagnostic,
	type DocumentDiagnosticReport,
	type FullDocumentDiagnosticReport,
	type UnchangedDocumentDiagnosticReport,
} from "vscode-languageserver-protocol";

import { diagnosticSourceKey, DiagnosticsLedger } from "../diagnostics/ledger.js";
import { LspClientDocuments } from "./documents.js";
import type {
	LspClientDocumentContext,
	LspConfig,
	LspDiagnosticSnapshot,
	LspRequestOptions,
	LspServerConfig,
} from "../types.js";

const DIAGNOSTIC_REQUEST_CONCURRENCY = 4;

export type LspSaveDiagnosticsResult =
	| { kind: "unavailable" }
	| { kind: "publish"; waitMs: number }
	| { kind: "pull"; snapshot?: LspDiagnosticSnapshot };

type DiagnosticsBucket = {
	document: LspClientDocumentContext;
	indices: [number, ...number[]];
};

/** 保存、发布和 pull diagnostics 的 client 内部状态。 */
export class LspClientDiagnostics {
	private readonly source: string;
	private readonly resultIds = new Map<string, string>();

	constructor(
		root: string,
		server: LspServerConfig,
		private readonly config: LspConfig,
		private readonly diagnostics: DiagnosticsLedger,
		private readonly documents: LspClientDocuments,
	) {
		this.source = diagnosticSourceKey(root, server.id);
	}

	publish(
		params: { uri: string; diagnostics: Diagnostic[]; version?: number },
		currentVersion: number | undefined,
	): void {
		if (params.version !== undefined && currentVersion !== undefined && params.version < currentVersion) return;
		this.diagnostics.update(
			this.source,
			params.uri,
			params.diagnostics,
			this.config.diagnostics.min_severity,
			params.version,
			this.config.diagnostics.max_related_locations,
		);
	}

	async collect(
		inputs: readonly { filePath: string; text: string }[],
		options: LspRequestOptions,
	): Promise<readonly LspSaveDiagnosticsResult[]> {
		if (inputs.length === 0) return [];
		const connection = this.documents.connection;

		const buckets = new Map<string, DiagnosticsBucket>();
		for (const [index, input] of inputs.entries()) {
			const document = this.documents.context(input.filePath, input.text);
			const bucket = buckets.get(document.uri);
			if (bucket === undefined) buckets.set(document.uri, { document, indices: [index] });
			else {
				bucket.document = document;
				bucket.indices.push(index);
			}
		}

		const unique = Array.from(buckets.values());
		let remainingSyncs = unique.length;
		let releaseSynchronized: () => void = () => undefined;
		const synchronized = new Promise<void>((resolve) => {
			releaseSynchronized = resolve;
		});
		let diagnosticDeadline = Number.POSITIVE_INFINITY;
		const diagnosticLimit = pLimit(DIAGNOSTIC_REQUEST_CONCURRENCY);
		const provider = connection.capabilities()?.diagnosticProvider;
		const pullProvider = typeof provider === "object" && provider !== null ? provider : undefined;
		const timeoutMs = options.timeoutMs ?? this.config.request_timeout_ms;

		const collected = await Promise.all(unique.map(async (bucket) => {
			const { document } = bucket;
			const result = await this.documents.enqueue(
				document.uri,
				async (): Promise<LspSaveDiagnosticsResult> => {
					let saved = false;
					try {
						saved = await this.documents.synchronizeAndSave(document);
					} finally {
						remainingSyncs -= 1;
						if (remainingSyncs === 0) {
							diagnosticDeadline = Date.now() + timeoutMs;
							releaseSynchronized();
						}
					}
					await synchronized;
					if (!saved) return { kind: "unavailable" };
					const remainingMs = (): number => Math.max(0, diagnosticDeadline - Date.now());
					if (pullProvider === undefined) return { kind: "publish", waitMs: remainingMs() };
					return diagnosticLimit(async () => {
						const availableMs = remainingMs();
						if (availableMs <= 0 || options.signal?.aborted === true) return { kind: "pull" };
						const previousResultId = this.resultIds.get(document.uri);
						const report = await connection.request(DocumentDiagnosticRequest.type, {
							textDocument: { uri: document.uri },
							...(pullProvider.identifier === undefined ? {} : { identifier: pullProvider.identifier }),
							...(previousResultId === undefined ? {} : { previousResultId }),
						}, { ...options, timeoutMs: availableMs });
						if (report === undefined) return { kind: "pull" };
						const snapshot = this.applyDocumentDiagnosticReport(document.uri, report);
						return snapshot === undefined ? { kind: "pull" } : { kind: "pull", snapshot };
					});
				},
			);
			return { bucket, result };
		}));

		for (const { document } of unique) await this.documents.trim(document.uri);
		const results: LspSaveDiagnosticsResult[] = [];
		for (const { bucket, result } of collected) {
			for (const index of bucket.indices) results[index] = result;
		}
		return results;
	}

	private applyDocumentDiagnosticReport(uri: string, report: DocumentDiagnosticReport): LspDiagnosticSnapshot | undefined {
		for (const [relatedUri, relatedReport] of Object.entries(report.relatedDocuments ?? {})) {
			this.applyDiagnosticReport(relatedUri, relatedReport);
		}
		return this.applyDiagnosticReport(uri, report);
	}

	private applyDiagnosticReport(
		uri: string,
		report: FullDocumentDiagnosticReport | UnchangedDocumentDiagnosticReport,
	): LspDiagnosticSnapshot | undefined {
		if (report.kind === "unchanged") {
			const snapshot = this.diagnostics.snapshot(this.source, uri);
			if (!snapshot.known) return undefined;
			this.resultIds.set(uri, report.resultId);
			return snapshot;
		}
		if (report.resultId === undefined) this.resultIds.delete(uri);
		else this.resultIds.set(uri, report.resultId);
		return this.diagnostics.update(
			this.source,
			uri,
			report.items,
			this.config.diagnostics.min_severity,
			this.documents.currentVersion(uri),
			this.config.diagnostics.max_related_locations,
		);
	}
}
