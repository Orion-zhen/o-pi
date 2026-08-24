import { describe, expect, it } from "vitest";

import { SubagentExecutionRegistry } from "../../src/subagent/execution-lifecycle.js";

describe("SubagentExecutionRegistry", () => {
	it("shutdown 中止全部未释放执行", () => {
		const registry = new SubagentExecutionRegistry();
		const first = registry.start();
		const second = registry.start();

		registry.abortAll();

		expect(first.signal.aborted).toBe(true);
		expect(second.signal.aborted).toBe(true);
		first.dispose();
		second.dispose();
	});

	it("正常完成释放自身，外部取消仍传播", () => {
		const registry = new SubagentExecutionRegistry();
		const external = new AbortController();
		const completed = registry.start();
		const active = registry.start(external.signal);

		completed.dispose();
		registry.abortAll();

		expect(completed.signal.aborted).toBe(false);
		expect(active.signal.aborted).toBe(true);

		const propagated = registry.start(external.signal);
		external.abort();
		expect(propagated.signal.aborted).toBe(true);
		propagated.dispose();
	});
});
