import pLimit from "p-limit";
import {
	DocumentDiagnosticRequest,
	type Diagnostic,
	type DocumentDiagnosticReport,
	type FullDocumentDiagnosticReport,
	type UnchangedDocumentDiagnosticReport,
} from "vscode-languageserver-protocol";

import { diagnosticSourceKey, DiagnosticsLedger } from "../diagnostics/ledger.ts";
import { LspClientDocuments } from "./documents.ts";
import type {
	LspClientDocumentContext,
	LspConfig,
	LspDiagnosticSnapshot,
	LspRequestOptions,
	LspServerConfig,
} from "../types.ts";

const DIAGNOSTIC_REQUEST_CONCURRENCY = 4;

export type LspSaveDiagnosticsResult =
	| { kind: "unavailable" }
	| { kind: "publish"; waitMs: number }
	| { kind: "pull"; snapshot?: LspDiagnosticSnapshot; related?: readonly LspDiagnosticSnapshot[] };

export type LspDiagnosticInput = LspClientDocumentContext;

export interface LspSavedDiagnostics<T extends LspDiagnosticInput> {
	readonly input: T;
	readonly result: LspSaveDiagnosticsResult;
}

type DiagnosticsBucket<T> = {
	document: LspClientDocumentContext;
	inputs: T[];
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

	async collect<T extends LspDiagnosticInput>(
		inputs: readonly T[],
		options: LspRequestOptions,
	): Promise<readonly LspSavedDiagnostics<T>[]> {
		if (inputs.length === 0) return [];
		const connection = this.documents.connection;

		const buckets = new Map<string, DiagnosticsBucket<T>>();
		for (const input of inputs) {
			const { uri, path, text, languageId } = input;
			const document: LspClientDocumentContext = { uri, path, text, languageId };
			const bucket = buckets.get(document.uri);
			if (bucket === undefined) buckets.set(document.uri, { document, inputs: [input] });
			else {
				bucket.document = document;
				bucket.inputs.push(input);
			}
		}

		const unique = Array.from(buckets.values());
		let remainingSyncs = unique.length;
		const synchronized = Promise.withResolvers<void>();
		let diagnosticDeadline = 0;
		const diagnosticLimit = pLimit(DIAGNOSTIC_REQUEST_CONCURRENCY);
		const provider = connection.capabilities().diagnosticProvider;
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
							synchronized.resolve();
						}
					}
					await synchronized.promise;
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
						if (report.status !== "ok") return { kind: "pull" };
						return this.applyDocumentDiagnosticReport(document.uri, report.value);
					});
				},
			);
			return { bucket, result };
		}));

		for (const { document } of unique) await this.documents.trim(document.uri);
		return collected.flatMap(({ bucket, result }) => bucket.inputs.map((input) => ({ input, result })));
	}

	private applyDocumentDiagnosticReport(uri: string, report: DocumentDiagnosticReport): LspSaveDiagnosticsResult {
		const related: LspDiagnosticSnapshot[] = [];
		for (const [relatedUri, relatedReport] of Object.entries(report.relatedDocuments ?? {})) {
			const snapshot = this.applyDiagnosticReport(relatedUri, relatedReport);
			if (snapshot !== undefined && relatedReport.kind === "full") related.push(snapshot);
		}
		const snapshot = this.applyDiagnosticReport(uri, report);
		return { kind: "pull", ...(snapshot === undefined ? {} : { snapshot }), ...(related.length === 0 ? {} : { related }) };
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
