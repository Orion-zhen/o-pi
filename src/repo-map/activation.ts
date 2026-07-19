import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { RepoMapFreshness } from "./types.js";

/** Repo Map 状态只写入不进入模型上下文的 session custom entry。 */
export const REPO_MAP_SESSION_ENTRY = "o-pi:repo-map";

export type RepoMapSessionEntry = RepoMapActivationEntry | RepoMapDeactivationEntry;

export interface RepoMapActivationEntry {
	kind: "activation";
	root: string;
	mapId: string;
	generation: string;
	activatedAt: string;
	freshness?: RepoMapFreshness;
	diagnostic?: string;
}

export interface RepoMapDeactivationEntry {
	kind: "deactivation";
	root?: string;
	deactivatedAt: string;
}

export interface RepoMapActivation {
	root: string;
	mapId: string;
	generation: string;
	activatedAt: string;
	freshness?: RepoMapFreshness;
	diagnostic?: string;
}

export interface RepoMapGateInput {
	activation?: RepoMapActivation;
	map?: {
		root: string;
		mapId: string;
		generation: string;
		freshness: RepoMapFreshness;
	};
	requestedPath: string;
}

export interface RepoMapGateResult {
	enabled: boolean;
	reason: "active" | "not_initialized" | "outside_repository" | "map_unavailable" | "map_stale";
	root?: string;
	mapId?: string;
}

/** 按 branch 时间线计算当前 activation；不读取磁盘，也不修改 session。 */
export function computeRepoMapActivation(branchEntries: SessionEntry[]): RepoMapActivation | undefined {
	let activation: RepoMapActivation | undefined;
	for (const branchEntry of branchEntries) {
		if (branchEntry.type !== "custom" || branchEntry.customType !== REPO_MAP_SESSION_ENTRY) continue;
		const entry = parseSessionEntry(branchEntry.data);
		if (entry === undefined) continue;
		if (entry.kind === "activation") {
			activation = {
				root: entry.root,
				mapId: entry.mapId,
				generation: entry.generation,
				activatedAt: entry.activatedAt,
				...(entry.freshness !== undefined ? { freshness: entry.freshness } : {}),
				...(entry.diagnostic !== undefined ? { diagnostic: entry.diagnostic } : {}),
			};
			continue;
		}
		if (entry.root === undefined || (activation !== undefined && pathsEqual(entry.root, activation.root))) activation = undefined;
	}
	return activation;
}

/** 显式 /init off 优先于后续 session_start 自动发现，直到用户再次初始化。 */
export function isRepoMapAutoActivationDisabled(branchEntries: SessionEntry[]): boolean {
	let disabled = false;
	for (const branchEntry of branchEntries) {
		if (branchEntry.type !== "custom" || branchEntry.customType !== REPO_MAP_SESSION_ENTRY) continue;
		const entry = parseSessionEntry(branchEntry.data);
		if (entry !== undefined) disabled = entry.kind === "deactivation";
	}
	return disabled;
}

/** 判断现有内存状态是否允许使用 Repo Map；调用方负责提供可信路径和 map 状态。 */
export function evaluateRepoMapGate(input: RepoMapGateInput): RepoMapGateResult {
	const activation = input.activation;
	if (activation === undefined) return { enabled: false, reason: "not_initialized" };
	const inactive = (reason: Exclude<RepoMapGateResult["reason"], "active">): RepoMapGateResult => ({
		enabled: false,
		reason,
		root: activation.root,
		mapId: activation.mapId,
	});
	const map = input.map;
	if (
		map === undefined
		|| !pathsEqual(map.root, activation.root)
		|| map.mapId !== activation.mapId
		|| map.generation !== activation.generation
	) return inactive("map_unavailable");
	if (!isPathInside(activation.root, input.requestedPath)) return inactive("outside_repository");
	if (map.freshness === "stale") return inactive("map_stale");
	if (map.freshness === "unavailable") return inactive("map_unavailable");
	return { enabled: true, reason: "active", root: activation.root, mapId: activation.mapId };
}

function parseSessionEntry(value: unknown): RepoMapSessionEntry | undefined {
	if (!isRecord(value) || typeof value["kind"] !== "string") return undefined;
	if (value["kind"] === "activation") {
		if (
			!isNonEmptyString(value["root"])
			|| !isNonEmptyString(value["mapId"])
			|| !isNonEmptyString(value["generation"])
			|| !isNonEmptyString(value["activatedAt"])
			|| (value["freshness"] !== undefined && !isFreshness(value["freshness"]))
			|| (value["diagnostic"] !== undefined && typeof value["diagnostic"] !== "string")
		) return undefined;
		return {
			kind: "activation",
			root: value["root"],
			mapId: value["mapId"],
			generation: value["generation"],
			activatedAt: value["activatedAt"],
			...(isFreshness(value["freshness"]) ? { freshness: value["freshness"] } : {}),
			...(typeof value["diagnostic"] === "string" ? { diagnostic: value["diagnostic"] } : {}),
		};
	}
	if (value["kind"] !== "deactivation" || !isNonEmptyString(value["deactivatedAt"])) return undefined;
	if (value["root"] !== undefined && !isNonEmptyString(value["root"])) return undefined;
	return {
		kind: "deactivation",
		...(typeof value["root"] === "string" ? { root: value["root"] } : {}),
		deactivatedAt: value["deactivatedAt"],
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isFreshness(value: unknown): value is RepoMapFreshness {
	return value === "fresh" || value === "partially_stale" || value === "stale" || value === "unavailable";
}

function pathsEqual(left: string, right: string): boolean {
	return path.relative(path.resolve(left), path.resolve(right)) === "";
}

function isPathInside(root: string, requestedPath: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(requestedPath));
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
