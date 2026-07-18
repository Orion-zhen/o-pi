import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const entry = fileURLToPath(new URL("../agent/extensions/repo-map.ts", import.meta.url));
const branch = [];
const commands = new Map();
const notifications = [];
const started = performance.now();
const jiti = createJiti(import.meta.url, { moduleCache: false });
const extension = await jiti.import(entry, { default: true });
extension({
	registerCommand(name, options) {
		commands.set(name, options);
	},
	appendEntry(customType, data) {
		branch.push({ type: "custom", id: String(branch.length), parentId: null, timestamp: "benchmark", customType, data });
	},
});
const registered = performance.now();
const init = commands.get("init");
if (init === undefined) throw new Error("Repo Map did not register /init");

const ctx = {
	cwd: "/repo-map-benchmark",
	signal: undefined,
	hasUI: false,
	mode: "print",
	sessionManager: { getBranch: () => branch },
	ui: {
		notify(message, type) {
			notifications.push([message, type]);
		},
		setStatus() {},
	},
};

const statusStarted = performance.now();
await init.handler("status", ctx);
const statusCompleted = performance.now();
await init.handler("off", ctx);
const offCompleted = performance.now();
if (notifications[0]?.[0] !== "Repo Map inactive" || notifications[1]?.[0] !== "Repo Map inactive") {
	throw new Error("inactive Repo Map command behavior changed");
}

branch.push({
	type: "custom",
	id: "active-benchmark",
	parentId: null,
	timestamp: "benchmark",
	customType: "o-pi:repo-map",
	data: {
		kind: "activation",
		root: "/repo-map-benchmark",
		mapId: "0".repeat(64),
		generation: "1".repeat(64),
		activatedAt: "2026-07-18T00:00:00.000Z",
	},
});
const activeStatusStarted = performance.now();
await init.handler("status", ctx);
const activeStatusLoaded = performance.now();
await init.handler("status", ctx);
const activeStatusWarm = performance.now();
if (!notifications[2]?.[0].includes("freshness: unavailable") || !notifications[3]?.[0].includes("freshness: unavailable")) {
	throw new Error("active Repo Map status behavior changed");
}

console.log(JSON.stringify({
	registrationMs: registered - started,
	inactiveStatusMs: statusCompleted - statusStarted,
	inactiveOffMs: offCompleted - statusCompleted,
	activeStatusFirstMs: activeStatusLoaded - activeStatusStarted,
	activeStatusWarmMs: activeStatusWarm - activeStatusLoaded,
}));
