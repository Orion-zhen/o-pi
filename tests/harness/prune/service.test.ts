import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager, sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

import { formatPruneOutcome } from "../../../src/harness/prune/presentation/outcome.ts";
import { estimateMessagesTokens, PRUNE_STATE, type PruneState } from "../../../src/harness/prune/prune.ts";
import {
	PruneService,
	type PruneServicePort,
} from "../../../src/harness/prune/service.ts";
import { deferred } from "../../helpers/async.ts";
import {
	assistant,
	customEntry,
	messageEntry,
	pruneState,
	restoreState,
	solModel,
	toolResult,
	transactionEntries,
	user,
	ZERO_USAGE,
} from "./fixtures.ts";

describe("PruneService", () => {
	it.each([false, true])("按模型能力重放提示词和工具变化，估算不重复累计（增量：%s）", async (supportsMidConvoSystemMessages) => {
		const read = { name: "read", description: "Read files", parameters: Type.Object({ path: Type.String() }) };
		const grep = { ...read, name: "grep", description: "Search files" };
		const first = { role: "system" as const, content: "Instructions", sections: { project: "OLD RULES" }, toolsAdded: [read], timestamp: 0 };
		const patch = { role: "system" as const, content: "", sections: { project: "NEW RULES" }, toolsRemoved: [{ name: "read" }], toolsAdded: [grep], timestamp: 4 };
		const conversation = [user("inspect"), assistant([{ type: "toolCall" as const, id: "done", name: "read", arguments: {} }], { ...ZERO_USAGE, cacheRead: 10000 }), toolResult("done", "output ".repeat(100))];
		const messages = [first, ...conversation, patch];
		const harness = createHarness(messages.map((message, index) => messageEntry(String(index), message)));
		const model = { ...solModel(), compat: { supportsMidConvoSystemMessages } };
		const result = await new PruneService().execute({ operation: "prune", model, port: harness.port });
		if (!("preview" in result)) throw new Error(JSON.stringify(result));
		const projected = supportsMidConvoSystemMessages ? messages : [
			{ ...first, sections: { project: "NEW RULES" }, toolsAdded: [grep] }, ...conversation,
		];
		const scope = { provider: model.provider, modelId: model.id, baseUrl: model.baseUrl };
		expect(result.preview.fullTokens).toBe(estimateMessagesTokens(projected, scope));
		expect(result.preview.commonPrefixTokens).toBe(estimateMessagesTokens(projected.slice(0, 2), scope));
		expect(messages).toEqual([first, ...conversation, patch]);
	});

	it("压缩后从 SDK 上下文恢复 system 快照，并允许裁剪保留的工具事务", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "system", content: "Keep instructions", timestamp: 0 });
		const firstKept = manager.appendMessage(user("inspect"));
		manager.appendMessage(assistant([{ type: "toolCall", id: "done", name: "read", arguments: {} }]));
		manager.appendMessage(toolResult("done", "output ".repeat(100)));
		manager.appendCompaction("earlier summary", firstKept, 10000);
		const harness = createHarness(manager.getEntries());
		harness.port.getMessages = () => manager.buildContextEntries().flatMap(sessionEntryToContextMessages);
		const result = await new PruneService().execute({ operation: "prune", model: { ...solModel(), cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }, port: harness.port });
		expect(result).toMatchObject({ status: "applied", result: { removedToolCalls: 1, removedToolResults: 1 } });
	});

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

	it("force 无需模型或成本估算", async () => {
		const harness = createHarness(transactionEntries());

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
	};
	return { port, appended };
}

function messagesFromEntries(entries: readonly SessionEntry[]): AgentMessage[] {
	return entries.flatMap((entry) => entry.type === "message" ? [entry.message] : []);
}
