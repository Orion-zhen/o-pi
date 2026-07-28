import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";

import { createFindEntry, rankFindSuggestions } from "../../src/file-tools/find/ranker.js";
import { AbortFindSuggestionRanking, FIND_CONCURRENCY, FindSuggestionRanker, shouldOffloadFindSuggestions } from "../../src/file-tools/find/suggestion-ranker.js";

function suggestionEntries(count = 6_000) {
	return Array.from({ length: count }, (_value, index) =>
		createFindEntry(`packages/component-${index}/parser-runtime-${index}.ts`, "file"));
}

describe("find suggestion workers", () => {
	it("并发路数取逻辑核心数的一半，动态边界只对足够大的零结果 fuzzy 集合启用", () => {
		expect(FIND_CONCURRENCY).toBe(Math.max(1, Math.floor(availableParallelism() / 2)));
		expect(shouldOffloadFindSuggestions(1_000, 3, { concurrency: 16, workerWarm: false })).toBe(false);
		expect(shouldOffloadFindSuggestions(10_000, 3, { concurrency: 16, workerWarm: false })).toBe(true);
		expect(shouldOffloadFindSuggestions(45_000, 3, { concurrency: 1, workerWarm: true })).toBe(false);
	});

	it("分块 worker 合并得到与单线程 Fuse 相同的全局 suggestions", async () => {
		const entries = suggestionEntries(9_000);
		const query = "parser worker runtime";
		const expected = rankFindSuggestions(entries, query, ".").map((item) => item.entry.path);
		const ranker = new FindSuggestionRanker({ workerLimit: 2 });
		try {
			const actual = await ranker.rank(entries, query, ".");
			expect(actual.matches).toEqual([]);
			expect(actual.suggestions.map((item) => item.entry.path)).toEqual(expected);
		} finally {
			ranker.dispose();
		}
	}, 0);

	it.each(["spawn", "post-message", "crash", "error-response", "invalid-response"] as const)("suggestion worker %s 失败时回退本地 ranking", async (failure) => {
		const entries = suggestionEntries();
		const query = "missing parser worker";
		const expected = rankFindSuggestions(entries, query, ".").map((item) => item.entry.path);
		const ranker = new FindSuggestionRanker({
			workerLimit: 2,
			createWorker: () => {
				if (failure === "spawn") throw new Error("injected spawn failure");
				const source = failure === "crash"
					? "parentPort.on('message', () => { throw new Error('injected crash'); });"
					: failure === "error-response"
						? "parentPort.on('message', ({ id }) => parentPort.postMessage({ id, error: 'injected error' }));"
						: "parentPort.on('message', ({ id }) => parentPort.postMessage({ id, paths: [42] }));";
				const worker = new Worker(`const { parentPort } = require('node:worker_threads'); ${source}`, { eval: true });
				if (failure === "post-message") worker.postMessage = () => { throw new Error("injected postMessage failure"); };
				return worker;
			},
		});
		try {
			const result = await ranker.rank(entries, query, ".");
			expect(result.matches).toEqual([]);
			expect(result.suggestions.map((item) => item.entry.path)).toEqual(expected);
		} finally {
			ranker.dispose();
		}
	}, 0);

	it.each(["abort", "dispose"] as const)("suggestion ranker active worker 在 %s 后退出且不执行本地 fallback", async (action) => {
		const exits: Array<Promise<number>> = [];
		const ranker = new FindSuggestionRanker({
			workerLimit: 2,
			createWorker: () => {
				const worker = new Worker("const { parentPort } = require('node:worker_threads'); parentPort.on('message', () => {});", { eval: true });
				exits.push(new Promise((resolve) => worker.once("exit", resolve)));
				return worker;
			},
		});
		const controller = new AbortController();
		const active = ranker.rank(suggestionEntries(), "missing parser worker", ".", controller.signal);
		if (action === "abort") controller.abort();
		else ranker.dispose();
		await expect(active).rejects.toBeInstanceOf(AbortFindSuggestionRanking);
		ranker.dispose();
		await Promise.all(exits);
	});

	it("suggestion ranker 生命周期局部、dispose 幂等且停止后拒绝调用", async () => {
		const disposed = new FindSuggestionRanker();
		const active = new FindSuggestionRanker();
		disposed.dispose();
		disposed.dispose();
		await expect(disposed.rank([createFindEntry("src/target.ts", "file")], "target", ".")).rejects.toBeInstanceOf(AbortFindSuggestionRanking);
		await expect(active.rank([createFindEntry("src/target.ts", "file")], "target", ".")).resolves.toMatchObject({
			matches: [{ entry: { path: "src/target.ts" } }],
		});
		active.dispose();
	});

});
