import { describe, expect, it } from "vitest";

import { SubagentExecutionRegistry } from "../../src/subagent/execution-lifecycle.js";

describe("SubagentExecutionRegistry", () => {
	it("shutdown 中止全部执行并释放 lease", () => {
		const registry = new SubagentExecutionRegistry();
		const first = registry.start();
		const external = new AbortController();
		const second = registry.start(external.signal);
		expect(registry.activeCount).toBe(2);

		registry.abortAll();

		expect(first.signal.aborted).toBe(true);
		expect(second.signal.aborted).toBe(true);
		expect(registry.activeCount).toBe(0);
		first.dispose();
		second.dispose();
		expect(registry.activeCount).toBe(0);
	});

	it("正常完成只释放自身，外部取消仍传播", () => {
		const registry = new SubagentExecutionRegistry();
		const external = new AbortController();
		const first = registry.start();
		const second = registry.start(external.signal);

		first.dispose();
		expect(registry.activeCount).toBe(1);
		expect(first.signal.aborted).toBe(false);
		external.abort();
		expect(second.signal.aborted).toBe(true);
		second.dispose();
		expect(registry.activeCount).toBe(0);
	});
});
