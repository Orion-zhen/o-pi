import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { formatPruneOutcome } from "../../src/prune/presentation/outcome.js";
import { PRUNE_STATE, type PruneState } from "../../src/prune/prune.js";
import {
	PruneService,
	type PruneServicePort,
} from "../../src/prune/service.js";
import { deferred } from "../helpers/async.js";
import {
	assistant,
	customEntry,
	messageEntry,
	pruneState,
	restoreState,
	solModel,
	toolResult,
	transactionEntries,
} from "./fixtures.js";

describe("PruneService", () => {
	it("成本允许时写入 checkpoint 并返回 JSON-safe 结果", async () => {
		const harness = createHarness(transactionEntries());
		const service = new PruneService();
		const model = {
			...solModel(),
			cost: { input: 0.5, output: 30, cacheRead: 0.5, cacheWrite: 0.5 },
		};

		const outcome = await service.execute({ operation: "prune", model, port: harness.port });

		expect(outcome).toMatchObject({
			status: "applied",
			operation: "prune",
			code: "PRUNED",
			result: { removedToolCalls: 1, removedToolResults: 1 },
			state: pruneState(["done"]),
		});
		expect(harness.appended).toEqual([{
			customType: PRUNE_STATE,
			state: pruneState(["done"]),
		}]);
		expect(structuredClone(outcome)).toEqual(JSON.parse(JSON.stringify(outcome)));
		expect(formatPruneOutcome(outcome).message).toContain("Next prompt:");
	});

	it("force 不读取模型、工具定义或成本输入", async () => {
		const harness = createHarness(transactionEntries());
		harness.port.getActiveTools = () => {
			throw new Error("force must not inspect active tools");
		};
		harness.port.getAllTools = () => {
			throw new Error("force must not inspect tool definitions");
		};
		harness.port.getSystemPrompt = () => {
			throw new Error("force must not inspect system prompt");
		};

		const outcome = await new PruneService().execute({
			operation: "force",
			model: undefined,
			port: harness.port,
		});

		expect(outcome).toMatchObject({
			status: "applied",
			operation: "force",
			code: "FORCE_PRUNED",
			state: pruneState(["done"]),
		});
		expect(formatPruneOutcome(outcome).message).toContain("Cost calculation was skipped.");
	});

	it("restore 撤销最近一次未撤销的 checkpoint", async () => {
		const entries = [
			messageEntry("assistant-a", assistant([{ type: "toolCall", id: "a", name: "read", arguments: {} }])),
			messageEntry("result-a", toolResult("a", "a output")),
			messageEntry("assistant-b", assistant([{ type: "toolCall", id: "b", name: "read", arguments: {} }])),
			messageEntry("result-b", toolResult("b", "b output")),
			customEntry(PRUNE_STATE, pruneState(["a"]), "prune-1"),
			customEntry(PRUNE_STATE, pruneState(["a", "b"], ["a"]), "prune-2"),
		];
		const harness = createHarness(entries);

		const outcome = await new PruneService().execute({
			operation: "restore",
			model: undefined,
			port: harness.port,
		});

		expect(outcome).toEqual({
			status: "applied",
			operation: "restore",
			code: "RESTORED",
			restoredToolCalls: 1,
			state: restoreState(["a"], "prune-2"),
		});
		expect(harness.appended).toEqual([{
			customType: PRUNE_STATE,
			state: restoreState(["a"], "prune-2"),
		}]);
	});

	it("compaction 导致事务缺失时返回稳定失败且不写 restore", async () => {
		const entries = [
			messageEntry("assistant-a", assistant([{ type: "toolCall", id: "a", name: "read", arguments: {} }])),
			messageEntry("result-a", toolResult("a", "a output")),
			customEntry(PRUNE_STATE, pruneState(["a", "b"]), "prune-1"),
		];
		const harness = createHarness(entries);

		const outcome = await new PruneService().execute({
			operation: "restore",
			model: undefined,
			port: harness.port,
		});

		expect(outcome).toEqual({
			status: "rejected",
			operation: "restore",
			code: "RESTORE_COMPACTED",
			missingToolCallIds: ["b"],
		});
		expect(harness.appended).toEqual([]);
	});

	it("无模型、无候选和无 restore 都返回结构化结果", async () => {
		const empty = createHarness([]);
		const service = new PruneService();

		expect(await service.execute({
			operation: "prune",
			model: undefined,
			port: empty.port,
		})).toEqual({ status: "rejected", operation: "prune", code: "MODEL_REQUIRED" });
		expect(await service.execute({
			operation: "force",
			model: undefined,
			port: empty.port,
		})).toEqual({ status: "skipped", operation: "force", code: "NO_CANDIDATES" });
		expect(await service.execute({
			operation: "restore",
			model: undefined,
			port: empty.port,
		})).toEqual({ status: "skipped", operation: "restore", code: "NO_RESTORE" });
	});

	it("等待 idle 后再变更状态，并在等待期间响应取消", async () => {
		const gate = deferred<void>();
		const entered = deferred<void>();
		const harness = createHarness(transactionEntries(), async () => {
			entered.resolve();
			await gate.promise;
		});
		const controller = new AbortController();
		const result = new PruneService().execute({
			operation: "force",
			model: undefined,
			port: harness.port,
			signal: controller.signal,
		});
		await entered.promise;
		expect(harness.appended).toEqual([]);

		controller.abort();
		gate.resolve();
		expect(await result).toEqual({
			status: "cancelled",
			operation: "force",
			code: "CANCELLED",
		});
		expect(harness.appended).toEqual([]);
	});

	it("并发操作串行读取最新 branch", async () => {
		const firstGate = deferred<void>();
		const firstEntered = deferred<void>();
		let waitCalls = 0;
		const harness = createHarness(transactionEntries(), async () => {
			waitCalls += 1;
			if (waitCalls === 1) {
				firstEntered.resolve();
				await firstGate.promise;
			}
		});
		const service = new PruneService();
		const first = service.execute({ operation: "force", model: undefined, port: harness.port });
		const second = service.execute({ operation: "force", model: undefined, port: harness.port });
		await firstEntered.promise;
		expect(waitCalls).toBe(1);

		firstGate.resolve();
		expect(await first).toMatchObject({ status: "applied", code: "FORCE_PRUNED" });
		expect(await second).toEqual({ status: "skipped", operation: "force", code: "NO_CANDIDATES" });
		expect(waitCalls).toBe(2);
		expect(harness.appended).toHaveLength(1);
	});
});

function createHarness(entries: SessionEntry[], waitForIdle: () => Promise<void> = async () => {}) {
	const appended: Array<{ customType: typeof PRUNE_STATE; state: PruneState }> = [];
	const port: PruneServicePort = {
		waitForIdle,
		getMessages: () => messagesFromEntries(entries),
		getBranch: () => entries,
		appendState(customType, state) {
			appended.push({ customType, state });
			entries.push(customEntry(customType, state, `${customType}-appended-${appended.length}`));
		},
		getActiveTools: () => [],
		getAllTools: () => [],
		getSystemPrompt: () => "",
	};
	return { port, appended };
}

function messagesFromEntries(entries: readonly SessionEntry[]): AgentMessage[] {
	return entries.flatMap((entry) => entry.type === "message" ? [entry.message] : []);
}
