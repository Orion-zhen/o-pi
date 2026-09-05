import { performance } from "node:perf_hooks";
import { loadTypeScript, fromRoot } from "../benchmark/loader.mjs";

if (process.argv[2] === "search") {
	await runSearchBenchmark();
} else {
	await runRegistrationBenchmark();
}

async function runRegistrationBenchmark() {
	const tools = new Map();
	const handlers = new Map();
	const started = performance.now();
	const extension = await loadTypeScript("agent/extensions/file-tools.ts", { defaultExport: true });
	extension({
		registerTool(tool) { tools.set(tool.name, tool); },
		on(event, handler) { handlers.set(event, handler); },
		// 基准不运行遥测扩展，也不预热 Pi 模块，只提供注册必需的事件接口。
		events: { emit() {}, on() { return () => {}; } },
	});
	const registered = performance.now();
	const ls = tools.get("ls");
	if (ls === undefined) throw new Error("ls was not registered");
	const ctx = {
		cwd: fromRoot(""),
		sessionManager: {
			getBranch: () => [],
			getSessionId: () => "file-tools-benchmark",
		},
	};
	try {
		const result = await ls.execute("benchmark", {}, undefined, undefined, ctx);
		if (result.details?.status === "failed") throw new Error(result.details.error.message);
		const completed = performance.now();
		console.log(JSON.stringify({ registrationMs: registered - started, firstToolMs: completed - registered }));
	} finally {
		await handlers.get("session_shutdown")({ reason: "exit" }, ctx);
	}
}

async function runSearchBenchmark() {
	const { findFiles } = await loadTypeScript("src/file-tools/find/command.ts");
	const { GrepTool } = await loadTypeScript("src/file-tools/grep/command.ts");
	const { FileToolsHost } = await loadTypeScript("src/file-tools/runtime/host.ts");
	const { FileSystemRuntime } = await loadTypeScript("src/filesystem/runtime.ts");
	const { NodeNativeFileSystem } = await loadTypeScript("src/filesystem/platform/node/native-filesystem.ts");

	const host = new FileToolsHost();
	const latencyHost = new FileToolsHost({
		filesystem: new FileSystemRuntime({ native: withOperationDelay(new NodeNativeFileSystem(), 2) }),
	});
	let grepHost = new FileToolsHost();
	let grepTool = new GrepTool();
	const find = async (params) => {
		const opened = await host.open({ cwd: fromRoot(""), sessionId: "benchmark-find" });
		if (opened.status === "failed") return opened;
		try {
			return await findFiles(params, { filesystem: opened.filesystem, operation: opened.context, limits: opened.limits });
		} finally {
			opened.dispose();
		}
	};
	const latencyFind = async (params) => {
		const opened = await latencyHost.open({ cwd: fromRoot(""), sessionId: "benchmark-latency-find" });
		if (opened.status === "failed") return opened;
		try {
			return await findFiles(params, { filesystem: opened.filesystem, operation: opened.context, limits: opened.limits });
		} finally {
			opened.dispose();
		}
	};
	const grep = async (params) => {
		const opened = await grepHost.open({ cwd: fromRoot(""), sessionId: "benchmark-grep" });
		if (opened.status === "failed") return opened;
		try {
			return await grepTool.execute(params, { filesystem: opened.filesystem, operation: opened.context, limits: opened.limits });
		} finally { opened.dispose(); }
	};
	const coldFindMs = await measure(() => find({ query: "file tools config" }));
	const warmFindMs = await measure(() => find({ query: "file tools config" }));
	const latencyFindMs = await measure(() => latencyFind({ query: "file tools config" }));
	const coldGrepMs = await measure(() => grep({ query: "createRetryableLoader" }));
	const warmGrepMs = await measure(() => grep({ query: "createRetryableLoader" }));

	grepTool.dispose();
	grepHost.dispose();
	grepTool = new GrepTool();
	grepHost = new FileToolsHost();
	const concurrentGrepMs = await measure(() => Promise.all([
		grep({ query: "createRetryableLoader" }),
		grep({ query: "createFileToolsExtension" }),
	]));
	const broadGrepMs = await measure(() => grep({
		query: "File Tools",
		path: ["src", "tests", "docs", "agent"],
	}));

	host.dispose();
	latencyHost.dispose();
	grepTool.dispose();
	grepHost.dispose();
	console.log(JSON.stringify({ coldFindMs, warmFindMs, latencyFindMs, coldGrepMs, warmGrepMs, concurrentGrepMs, broadGrepMs }));
}

async function measure(operation) {
	const started = performance.now();
	const result = await operation();
	const values = Array.isArray(result) ? result : [result];
	if (values.some((value) => value?.status === "failed")) throw new Error("search benchmark operation failed");
	return performance.now() - started;
}

function withOperationDelay(base, milliseconds) {
	return new Proxy(base, {
		get(target, property) {
			const value = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			return async (...args) => {
				await new Promise((resolve) => setTimeout(resolve, milliseconds));
				return await value.apply(target, args);
			};
		},
	});
}
