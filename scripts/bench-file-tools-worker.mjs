import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const root = fileURLToPath(new URL("..", import.meta.url));
const entry = fileURLToPath(new URL("../agent/extensions/file-tools.ts", import.meta.url));
const tools = new Map();
const started = performance.now();
const jiti = createJiti(import.meta.url, { moduleCache: false });
const extension = await jiti.import(entry, { default: true });
extension({
	registerTool(tool) {
		tools.set(tool.name, tool);
	},
	on() {},
});
const registered = performance.now();
const ls = tools.get("ls");
if (ls === undefined) throw new Error("ls was not registered");
await ls.execute("benchmark", {}, undefined, undefined, {
	cwd: root,
	sessionManager: {
		getBranch: () => [],
		getSessionId: () => "file-tools-benchmark",
	},
});
const completed = performance.now();
console.log(JSON.stringify({
	registrationMs: registered - started,
	firstToolMs: completed - registered,
}));
