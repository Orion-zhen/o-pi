import { vi } from "vitest";

// Vitest 由 Node 运行。只替换测试中的 TS 加载入口，worker 仍执行正式解析代码。
vi.mock("../../src/harness/worker-runtime/typescript-worker.ts", async () => {
	const { Worker } = await import("node:worker_threads");
	return {
		createTypeScriptWorker: (entry: URL) => new Worker(new URL("./typescript-worker.mjs", import.meta.url), { workerData: entry.href }),
	};
});
