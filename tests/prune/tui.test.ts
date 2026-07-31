import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
	SessionShutdownEvent,
	SessionStartEvent,
	SessionTreeEvent,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";

import pruneExtension from "../../agent/extensions/prune.js";
import {
	getPruneTuiState,
	isToolCallHidden,
	PruneSummaryComponent,
	reducePruneTuiState,
	resetPruneTuiState,
	syncPruneTuiState,
} from "../../src/prune/tui/index.js";
import { pruneEntry, pruneState, restoreState } from "./fixtures.js";

type SessionStartHandler = (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void> | void;
type SessionTreeHandler = (event: SessionTreeEvent, ctx: ExtensionContext) => Promise<void> | void;
type SessionShutdownHandler = (event: SessionShutdownEvent, ctx: ExtensionContext) => Promise<void> | void;

const theme = {
	fg(_color: "dim", text: string) {
		return text;
	},
};

beforeEach(() => {
	resetPruneTuiState();
});

describe("prune TUI state", () => {
	const first = pruneEntry("prune-1", pruneState(["a", "b"]));
	const second = pruneEntry("prune-2", pruneState(["a", "b", "c"], ["a", "b"]));
	const restoreSecond = pruneEntry("restore-2", restoreState(["a", "b"], "prune-2"));
	const restoreFirst = pruneEntry("restore-1", restoreState([], "prune-1"));

	it.each([
		{
			name: "空分支",
			entries: [],
			expected: { entryId: undefined, operation: undefined, changed: 0, total: 0, hidden: [] },
		},
		{
			name: "第一次 prune",
			entries: [first],
			expected: { entryId: "prune-1", operation: "prune", changed: 2, total: 2, hidden: ["a", "b"] },
		},
		{
			name: "连续 prune",
			entries: [first, second],
			expected: { entryId: "prune-2", operation: "prune", changed: 1, total: 3, hidden: ["a", "b", "c"] },
		},
		{
			name: "恢复最近一次 prune",
			entries: [first, second, restoreSecond],
			expected: { entryId: "restore-2", operation: "restore", changed: 1, total: 2, hidden: ["a", "b"] },
		},
		{
			name: "连续 restore",
			entries: [first, second, restoreSecond, restoreFirst],
			expected: { entryId: "restore-1", operation: "restore", changed: 2, total: 0, hidden: [] },
		},
	])("归约 $name 的最新视觉快照", ({ entries, expected }) => {
		const state = reducePruneTuiState(entries);

		expect(state.latestCheckpointEntryId).toBe(expected.entryId);
		expect(state.operation).toBe(expected.operation);
		expect(state.changedToolCalls).toBe(expected.changed);
		expect(state.hiddenToolCalls).toBe(expected.total);
		expect([...state.hiddenToolCallIds]).toEqual(expected.hidden);
	});

	it("兄弟分支分别归约自己的最新 checkpoint", () => {
		const left = pruneEntry("prune-left", pruneState(["a", "left"], ["a"]));
		const right = pruneEntry("prune-right", pruneState(["a", "right"], ["a"]));

		expect(reducePruneTuiState([first, left])).toMatchObject({
			latestCheckpointEntryId: "prune-left",
			hiddenToolCalls: 2,
		});
		expect([...reducePruneTuiState([first, left]).hiddenToolCallIds]).toEqual(["a", "left"]);
		expect(reducePruneTuiState([first, right])).toMatchObject({
			latestCheckpointEntryId: "prune-right",
			hiddenToolCalls: 2,
		});
		expect([...reducePruneTuiState([first, right]).hiddenToolCallIds]).toEqual(["a", "right"]);
	});

	it("同步、查询和 reset 不保留上一个 branch 的状态", () => {
		syncPruneTuiState([first, second]);
		expect(isToolCallHidden("c")).toBe(true);

		syncPruneTuiState([first]);
		expect(isToolCallHidden("c")).toBe(false);
		expect(isToolCallHidden("a")).toBe(true);

		resetPruneTuiState();
		expect(getPruneTuiState()).toMatchObject({
			latestCheckpointEntryId: undefined,
			hiddenToolCalls: 0,
		});
	});

	it("动态摘要只让当前 branch 的最新 checkpoint 输出一行", () => {
		const firstComponent = new PruneSummaryComponent("prune-1", theme);
		const secondComponent = new PruneSummaryComponent("prune-2", theme);
		const restoreComponent = new PruneSummaryComponent("restore-2", theme);

		syncPruneTuiState([first, second]);
		expect(firstComponent.render(80)).toEqual([]);
		expect(secondComponent.render(80)).toHaveLength(1);
		const narrowSummary = secondComponent.render(8);
		expect(narrowSummary).toHaveLength(1);
		expect(visibleWidth(narrowSummary[0] ?? "")).toBeLessThanOrEqual(8);

		syncPruneTuiState([first, second, restoreSecond]);
		expect(secondComponent.render(80)).toEqual([]);
		expect(restoreComponent.render(80)).toHaveLength(1);
	});

	it("session start、tree 导航和 shutdown 同步或清理当前 branch", async () => {
		const harness = lifecycleHarness([first]);
		await harness.sessionStart({ type: "session_start", reason: "startup" }, harness.ctx);
		expect(getPruneTuiState().latestCheckpointEntryId).toBe("prune-1");

		harness.branch = [first, second];
		await harness.sessionTree(
			{ type: "session_tree", newLeafId: "prune-2", oldLeafId: "prune-1" },
			harness.ctx,
		);
		expect(getPruneTuiState().latestCheckpointEntryId).toBe("prune-2");
		expect(isToolCallHidden("c")).toBe(true);

		await harness.sessionShutdown({ type: "session_shutdown", reason: "reload" }, harness.ctx);
		expect(getPruneTuiState().latestCheckpointEntryId).toBeUndefined();
	});

	it("非 TUI session 不同步视觉状态", async () => {
		const harness = lifecycleHarness([first], "rpc");
		await harness.sessionStart({ type: "session_start", reason: "startup" }, harness.ctx);
		expect(getPruneTuiState().latestCheckpointEntryId).toBeUndefined();
	});
});

function lifecycleHarness(initialBranch: SessionEntry[], mode: ExtensionContext["mode"] = "tui") {
	let branch = initialBranch;
	let sessionStart: SessionStartHandler | undefined;
	let sessionTree: SessionTreeHandler | undefined;
	let sessionShutdown: SessionShutdownHandler | undefined;
	const pi: Pick<
		ExtensionAPI,
		"appendEntry" | "getActiveTools" | "getAllTools" | "on" | "registerCommand" | "registerEntryRenderer"
	> = {
		appendEntry() {},
		getActiveTools: () => [],
		getAllTools: () => [],
		on(event, handler) {
			if (event === "session_start") sessionStart = handler as SessionStartHandler;
			if (event === "session_tree") sessionTree = handler as SessionTreeHandler;
			if (event === "session_shutdown") sessionShutdown = handler as SessionShutdownHandler;
		},
		registerCommand() {},
		registerEntryRenderer() {},
	};
	pruneExtension(pi);
	if (!sessionStart || !sessionTree || !sessionShutdown) throw new Error("missing prune lifecycle handler");

	const ctx = {
		mode,
		sessionManager: {
			getBranch: () => branch,
		},
	} as ExtensionContext;

	return {
		ctx,
		sessionStart,
		sessionTree,
		sessionShutdown,
		set branch(entries: SessionEntry[]) {
			branch = entries;
		},
	};
}
