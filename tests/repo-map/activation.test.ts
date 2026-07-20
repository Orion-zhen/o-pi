import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
	advanceRepoMapActivation,
	computeRepoMapActivation,
	evaluateRepoMapGate,
	REPO_MAP_SESSION_ENTRY,
	type RepoMapActivation,
	type RepoMapSessionEntry,
} from "../../src/repo-map/activation.js";
import type { RepoMapFreshness } from "../../src/repo-map/types.js";

const root = path.resolve("repo");
const activation: RepoMapActivation = {
	root,
	mapId: "map-1",
	generation: "generation-1",
	activatedAt: "2026-07-17T00:00:00.000Z",
};

describe("Repo Map session activation", () => {
	it("最后一条有效 activation 或全局 deactivation 决定状态", () => {
		const first = activate("/first", "map-first");
		const second = activate("/second", "map-second");
		expect(computeRepoMapActivation([custom("1", first), custom("2", second)])).toMatchObject({ root: "/second", mapId: "map-second" });
		expect(computeRepoMapActivation([custom("1", first), custom("2", deactivate())])).toBeUndefined();
		expect(computeRepoMapActivation([custom("1", first), custom("2", deactivate()), custom("3", second)])).toMatchObject({ root: "/second" });
	});

	it("root-specific deactivation 只关闭匹配的当前 activation", () => {
		const active = activate(root, "map-1");
		expect(computeRepoMapActivation([custom("1", active), custom("2", deactivate(path.join(root, "other")))])).toMatchObject({ root });
		expect(computeRepoMapActivation([custom("1", active), custom("2", deactivate(path.join(root, ".")))])).toBeUndefined();
	});

	it("增量计算与全量 branch 扫描一致", () => {
		const first = custom("1", activate(root, "map-1"));
		const appended = [message("2"), custom("3", activate("/second", "map-2"))];
		expect(advanceRepoMapActivation(computeRepoMapActivation([first]), appended)).toEqual(
			computeRepoMapActivation([first, ...appended]),
		);
	});

	it("忽略 malformed entry、其他 customType 和非 custom branch entry，并保留 branch 顺序", () => {
		const entries: SessionEntry[] = [
			message("0"),
			custom("1", { kind: "activation", root, mapId: "", generation: "g", activatedAt: "t" }),
			custom("2", activate(root, "map-1"), "other:custom-type"),
			custom("3", activate(root, "map-1")),
			custom("4", { kind: "deactivation", root: 42, deactivatedAt: "t" }),
		];
		expect(computeRepoMapActivation(entries)).toEqual(activation);
	});
});

describe("Repo Map activation gate", () => {
	it("未激活时关闭", () => {
		expect(evaluateRepoMapGate({ requestedPath: root })).toEqual({ enabled: false, reason: "not_initialized" });
	});

	it.each([
		["missing map", undefined],
		["root mismatch", mapState("fresh", { root: path.resolve("other") })],
		["map ID mismatch", mapState("fresh", { mapId: "map-2" })],
		["generation mismatch", mapState("fresh", { generation: "generation-2" })],
	] as const)("map 不可用：%s", (_label, map) => {
		expect(evaluateRepoMapGate({ activation, ...(map !== undefined ? { map } : {}), requestedPath: root })).toMatchObject({
			enabled: false,
			reason: "map_unavailable",
		});
	});

	it.each([
		["fresh", true, "active"],
		["partially_stale", true, "active"],
		["stale", false, "map_stale"],
		["unavailable", false, "map_unavailable"],
	] as const)("freshness=%s", (freshness, enabled, reason) => {
		expect(evaluateRepoMapGate({ activation, map: mapState(freshness), requestedPath: root })).toEqual({
			enabled,
			reason,
			root,
			mapId: "map-1",
		});
	});

	it.each([
		["repository root", root, true],
		["repository child", path.join(root, "src", "..", "src", "app.ts"), true],
		["redundant separators", `${root}${path.sep}${path.sep}src`, true],
		["sibling prefix", `${root}-other`, false],
		["outside path", path.resolve("outside", "app.ts"), false],
	] as const)("路径包含：%s", (_label, requestedPath, inside) => {
		expect(evaluateRepoMapGate({ activation, map: mapState("fresh"), requestedPath })).toMatchObject({
			enabled: inside,
			reason: inside ? "active" : "outside_repository",
		});
	});
});

function custom(id: string, data: unknown, customType = REPO_MAP_SESSION_ENTRY): SessionEntry {
	return { type: "custom", id, parentId: null, timestamp: "t", customType, data };
}

function message(id: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "t",
		message: { role: "user", content: "ignored", timestamp: 0 },
	};
}

function activate(activeRoot: string, mapId: string): RepoMapSessionEntry {
	return { kind: "activation", root: activeRoot, mapId, generation: "generation-1", activatedAt: "2026-07-17T00:00:00.000Z" };
}

function deactivate(activeRoot?: string): RepoMapSessionEntry {
	return { kind: "deactivation", ...(activeRoot !== undefined ? { root: activeRoot } : {}), deactivatedAt: "2026-07-17T00:01:00.000Z" };
}

function mapState(freshness: RepoMapFreshness, overrides: Partial<NonNullable<Parameters<typeof evaluateRepoMapGate>[0]["map"]>> = {}) {
	return { root, mapId: "map-1", generation: "generation-1", freshness, ...overrides };
}
