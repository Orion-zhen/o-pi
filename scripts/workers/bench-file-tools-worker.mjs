import { performance } from "node:perf_hooks";
import { loadTypeScript, fromRoot } from "../benchmark/loader.mjs";

if (process.argv[2] === "search") {
	await runSearchBenchmark();
} else {
	await runRegistrationBenchmark();
}

async function runRegistrationBenchmark() {
	const tools = new Map();
	const started = performance.now();
	const extension = await loadTypeScript("agent/extensions/file-tools.ts", { defaultExport: true });
	extension({
		registerTool(tool) { tools.set(tool.name, tool); },
		on() {},
	});
	const registered = performance.now();
	const ls = tools.get("ls");
	if (ls === undefined) throw new Error("ls was not registered");
	await ls.execute("benchmark", {}, undefined, undefined, {
		cwd: fromRoot(""),
		sessionManager: {
			getBranch: () => [],
			getSessionId: () => "file-tools-benchmark",
		},
	});
	const completed = performance.now();
	console.log(JSON.stringify({ registrationMs: registered - started, firstToolMs: completed - registered }));
}

async function runSearchBenchmark() {
	const { FindTool } = await loadTypeScript("src/file-tools/find/command.ts");
	const { GrepTool } = await loadTypeScript("src/file-tools/grep/command.ts");
	const { FileToolsHost } = await loadTypeScript("src/file-tools/runtime/host.ts");

	const host = new FileToolsHost();
	const findTool = new FindTool();
	let grepHost = new FileToolsHost();
	let grepTool = new GrepTool();
	const find = async (params) => {
		const opened = await host.open({ cwd: fromRoot(""), sessionId: "benchmark-find" });
		if (opened.status === "failed") return opened;
		try {
			return await findTool.execute(params, { filesystem: opened.filesystem, operation: opened.context, limits: opened.limits });
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
	const coldGrepMs = await measure(() => grep({ query: "createRetryableLoader", match: "literal" }));
	const warmGrepMs = await measure(() => grep({ query: "createRetryableLoader", match: "literal" }));

	grepTool.dispose();
	grepHost.dispose();
	grepTool = new GrepTool();
	grepHost = new FileToolsHost();
	const concurrentGrepMs = await measure(() => Promise.all([
		grep({ query: "createRetryableLoader", match: "literal" }),
		grep({ query: "createLazyRepoMap", match: "literal" }),
	]));
	const broadAutoGrepMs = await measure(() => grep({
		query: "Repo Map",
		path: ["src", "tests", "docs", "agent"],
		match: "auto",
	}));

	findTool.dispose();
	host.dispose();
	grepTool.dispose();
	grepHost.dispose();
	console.log(JSON.stringify({ coldFindMs, warmFindMs, coldGrepMs, warmGrepMs, concurrentGrepMs, broadAutoGrepMs }));
}

async function measure(operation) {
	const started = performance.now();
	const result = await operation();
	const values = Array.isArray(result) ? result : [result];
	if (values.some((value) => value?.status === "failed")) throw new Error("search benchmark operation failed");
	return performance.now() - started;
}
