import { Worker } from "node:worker_threads";

const bootstrap = new URL("./typescript-worker-bootstrap.mjs", import.meta.url);

/** 源码运行使用 TS 引导器，发行构建直接启动对应的 ESM worker。 */
export function createTypeScriptWorker(entry: URL): Worker {
	if (import.meta.url.endsWith(".ts")) return new Worker(bootstrap, { workerData: entry.href });
	return new Worker(new URL(entry.href.replace(/\.ts$/, ".js")));
}
