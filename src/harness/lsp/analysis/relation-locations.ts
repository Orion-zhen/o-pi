import type { Range } from "vscode-languageserver-protocol";
import { SourceIndex } from "../../code-index/source-index.ts";
import { containsRange, hasStructuralRange } from "../../code-index/structure.ts";
import { compareCodeUnitNesting, matchesDeclaration } from "../../code-index/units.ts";
import type { AnalyzedFileIndex, CodeAnalysisStatus, CodeDocument, IndexedCodeUnit, SourceRange } from "../../code-index/types.ts";
import type { CodeRelationLocation, CodeRelationTarget } from "../../code-index/relation-types.ts";
import { fileUriToPath, workspaceRelativePath } from "../protocol/uri.ts";
import { sourceRange } from "./document.ts";
import type { LspCodeAnalysisInput } from "./code-analysis.ts";
import { combinedStatus, type AnalysisRequests } from "./requests.ts";

interface Snapshot {
	readonly document: CodeDocument;
	readonly analysis: AnalyzedFileIndex;
	readonly index: SourceIndex;
}

/** 所有关系位置都经过调用方的 scope、正文快照和坐标校验。只缓存本次分析。 */
export class RelationLocations {
	private readonly snapshots = new Map<string, Promise<Snapshot | undefined>>();
	private readonly orderedUnits = new WeakMap<Snapshot, readonly IndexedCodeUnit[]>();
	private inspected = 0;
	private readonly failures = new Set<CodeAnalysisStatus>();

	get status(): CodeAnalysisStatus { return combinedStatus([...this.failures]); }

	constructor(private readonly input: LspCodeAnalysisInput, private readonly requests: AnalysisRequests, readonly current: Snapshot) {
		this.snapshots.set(current.document.path, Promise.resolve(current));
	}

	async location(uri: string, range: Range): Promise<CodeRelationLocation | undefined> {
		const snapshot = await this.snapshot(uri);
		if (snapshot === undefined) return undefined;
		const extent = sourceRange(snapshot.document.text, snapshot.index, range);
		if (extent === undefined) { this.failures.add("unavailable"); return undefined; }
		let units = this.orderedUnits.get(snapshot);
		if (units === undefined) {
			units = snapshot.analysis.units.filter(hasStructuralRange).sort(compareCodeUnitNesting);
			this.orderedUnits.set(snapshot, units);
		}
		const unit = units.find((unit) => containsRange(unit, extent));
		return this.at(snapshot, extent, unit?.id);
	}

	async target(uri: string, range: Range, hierarchy: boolean): Promise<CodeRelationTarget> {
		const candidate = { uri, range };
		const snapshot = await this.snapshot(uri);
		if (snapshot === undefined) return { ...candidate, status: "unavailable" };
		const extent = sourceRange(snapshot.document.text, snapshot.index, range);
		if (extent === undefined) { this.failures.add("unavailable"); return { ...candidate, status: "unavailable" }; }
		const units = snapshot.analysis.units.filter((unit) => matchesDeclaration(unit, extent));
		const unit = units.length === 1 ? units[0] : undefined;
		const callable = hierarchy || unit !== undefined && ((unit.syntax?.errors.length ?? 0) === 0 && unit.syntax?.callable === true
			|| unit.symbol !== undefined && ["function", "method", "constructor"].includes(unit.kind));
		return { ...candidate, status: "ok", location: this.at(snapshot, extent, unit?.id), binding: callable ? "callable" : "indirect" };
	}

	local(range: SourceRange, unitId?: string): CodeRelationLocation {
		return this.at(this.current, range, unitId);
	}

	private at(snapshot: Snapshot, range: SourceRange, unitId?: string): CodeRelationLocation {
		const position = snapshot.index.positionForByte(range.startByte);
		if (position === undefined) throw new RangeError("Invalid source boundary");
		return {
			path: snapshot.document.path, hash: snapshot.document.hash, range,
			line: position.line + 1, column: position.character + 1,
			...(unitId === undefined ? {} : { unitId }),
		};
	}

	private snapshot(uri: string): Promise<Snapshot | undefined> {
		const native = fileUriToPath(uri);
		const path = native === undefined ? undefined : workspaceRelativePath(this.input.root, native);
		if (path === undefined) { this.failures.add("skipped"); return Promise.resolve(undefined); }
		const cached = this.snapshots.get(path);
		if (cached !== undefined) return cached;
		if (this.inspected++ >= 16) {
			this.failures.add("skipped");
			return Promise.resolve(undefined);
		}
		const pending = this.requests.run(true, async (options) => {
			const document = await this.input.load(path);
			if (document === undefined || options.signal.aborted) return undefined;
			const analysis = await this.input.syntax(document, options.signal);
			return { document, analysis, index: new SourceIndex(document.text) };
		}).then((result) => {
			if (result.status === "ok") return result.value;
			this.failures.add(result.status);
			return undefined;
		});
		this.snapshots.set(path, pending);
		return pending;
	}
}

