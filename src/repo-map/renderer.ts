import type { InitializeRepoMapResult } from "./service.js";
import type { RepoMapMetadata } from "./types.js";

export function renderInitialization(result: InitializeRepoMapResult): string {
	const summary = result.summary;
	return [
		"Repo Map active",
		`root: ${result.metadata.repositoryRoot}`,
		`generation: ${shortHash(result.metadata.generation)}${result.reusedGeneration ? " (reused)" : ""}`,
		`files: ${summary.indexed} indexed, ${summary.tooLarge} too large`,
		`code: ${summary.parsed} parsed, ${summary.unsupported} unsupported, ${summary.parseErrors} errors`,
		`graph: ${summary.symbols} symbols, ${summary.edges} edges`,
		`changes: ${summary.added} added, ${summary.changed} changed, ${summary.removed} removed, ${summary.reused} reused`,
		`freshness: ${result.metadata.freshness}`,
	].join("\n");
}

export function renderStatus(metadata: RepoMapMetadata): string {
	return [
		"Repo Map active",
		`root: ${metadata.repositoryRoot}`,
		`map id: ${shortHash(metadata.mapId)}`,
		`generation: ${shortHash(metadata.generation)}`,
		`freshness: ${metadata.freshness}`,
		`updated time: ${metadata.updatedAt}`,
		`files: ${metadata.fileCount}`,
		`indexed files: ${metadata.indexedFileCount}`,
		`parsed files: ${metadata.parsedFileCount}`,
		`unsupported files: ${metadata.unsupportedFileCount}`,
		`parse errors: ${metadata.parseErrorFileCount}`,
		`symbols: ${metadata.symbolCount}`,
		`edges: ${metadata.edgeCount}`,
		`aliases: ${metadata.aliasCount}`,
		`too-large files: ${metadata.tooLargeFileCount}`,
		`diagnostics: ${metadata.diagnosticCount}`,
		`cache schema: ${metadata.schemaVersion}`,
	].join("\n");
}

export function renderUnavailableStatus(activation: { root: string; mapId: string; generation: string }): string {
	return [
		"Repo Map active",
		`root: ${activation.root}`,
		`map id: ${shortHash(activation.mapId)}`,
		`generation: ${shortHash(activation.generation)}`,
		"freshness: unavailable",
	].join("\n");
}

function shortHash(value: string): string {
	return value.slice(0, 8);
}
