import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { createBashToolExtension } from "../../agent/extensions/bash-tool.js";
import { createFileToolsExtension } from "../../agent/extensions/file-tools.js";
import { createPruneExtension } from "../../agent/extensions/prune.js";
import { createSkillContextExtension } from "../../agent/extensions/skill-context.js";
import { createSubagentExtension } from "../../agent/extensions/subagent.js";
import { createWebToolsExtension } from "../../agent/extensions/web-tools.js";

type ExtensionRegistration = (pi: ExtensionAPI) => void;
type SessionStartHandler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;

interface LoaderCase {
	name: string;
	create(failFirst: boolean): {
		extension: ExtensionRegistration;
		loadCount(): number;
	};
}

const cases: LoaderCase[] = [
	{
		name: "bash",
		create: (failFirst) => {
			let calls = 0;
			const load = async () => {
				calls += 1;
				if (failFirst && calls === 1) throw new Error("expected failure");
				return import("../../src/bash-tool/tui/renderer.js");
			};
			return { extension: createBashToolExtension(load), loadCount: () => calls };
		},
	},
	{
		name: "prune",
		create: (failFirst) => {
			let calls = 0;
			const load = async () => {
				calls += 1;
				if (failFirst && calls === 1) throw new Error("expected failure");
				return import("../../src/prune/tui/index.js");
			};
			return { extension: createPruneExtension(load), loadCount: () => calls };
		},
	},
	{
		name: "file",
		create: (failFirst) => {
			let calls = 0;
			const load = async () => {
				calls += 1;
				if (failFirst && calls === 1) throw new Error("expected failure");
				return import("../../src/file-tools/tui/index.js");
			};
			return { extension: createFileToolsExtension({ renderers: load }), loadCount: () => calls };
		},
	},
	{
		name: "web",
		create: (failFirst) => {
			let calls = 0;
			const load = async () => {
				calls += 1;
				if (failFirst && calls === 1) throw new Error("expected failure");
				const [webfetch, websearch] = await Promise.all([
					import("../../src/web-tools/tui/webfetch.js"),
					import("../../src/web-tools/tui/websearch.js"),
				]);
				return { ...webfetch, ...websearch };
			};
			const unreachableRuntime = async () => {
				throw new Error("runtime must not load during session start");
			};
			return { extension: createWebToolsExtension(unreachableRuntime, load), loadCount: () => calls };
		},
	},
	{
		name: "skill",
		create: (failFirst) => {
			let calls = 0;
			const load = async () => {
				calls += 1;
				if (failFirst && calls === 1) throw new Error("expected failure");
				return import("../../src/skill-context/tui/renderer.js");
			};
			return { extension: createSkillContextExtension(load), loadCount: () => calls };
		},
	},
	{
		name: "subagent",
		create: (failFirst) => {
			let calls = 0;
			const load = async () => {
				calls += 1;
				if (failFirst && calls === 1) throw new Error("expected failure");
				return import("../../src/subagent/tui/adapter.js");
			};
			return { extension: createSubagentExtension(load), loadCount: () => calls };
		},
	},
];

describe.each(cases)("$name TUI loader", ({ create }) => {
	it("rpc/json/print 不加载，重复 TUI start 只加载一次", async () => {
		const value = create(false);
		const harness = register(value.extension);
		const coreRegistrations = harness.registrationCount;
		for (const mode of ["rpc", "json", "print"] as const) {
			await harness.sessionStart({}, context(mode).ctx);
		}
		expect(value.loadCount()).toBe(0);
		expect(harness.registrationCount).toBe(coreRegistrations);

		await harness.sessionStart({}, context("tui").ctx);
		await harness.sessionStart({}, context("tui").ctx);
		expect(value.loadCount()).toBe(1);
		expect(harness.registrationCount).toBeGreaterThan(coreRegistrations);
	});

	it("加载失败保留核心注册并允许下一次 TUI start 重试", async () => {
		const value = create(true);
		const harness = register(value.extension);
		const coreRegistrations = harness.registrationCount;
		const firstContext = context("tui");
		await harness.sessionStart({}, firstContext.ctx);
		expect(value.loadCount()).toBe(1);
		expect(harness.registrationCount).toBe(coreRegistrations);
		expect(firstContext.notify).toHaveBeenCalledWith(expect.stringContaining("expected failure"), "warning");

		await harness.sessionStart({}, context("tui").ctx);
		expect(value.loadCount()).toBe(2);
		expect(harness.registrationCount).toBeGreaterThan(coreRegistrations);
	});
});

function register(extension: ExtensionRegistration): {
	sessionStart: SessionStartHandler;
	readonly registrationCount: number;
} {
	let sessionStart: SessionStartHandler | undefined;
	let registrationCount = 0;
	const pi = Object.assign({} as ExtensionAPI, {
		registerTool() {
			registrationCount += 1;
		},
		registerCommand() {
			registrationCount += 1;
		},
		registerEntryRenderer() {
			registrationCount += 1;
		},
		registerMessageRenderer() {
			registrationCount += 1;
		},
		on(event: string, handler: unknown) {
			if (event === "session_start") sessionStart = handler as SessionStartHandler;
		},
		appendEntry() {},
		getActiveTools: () => [],
		getAllTools: () => [],
		getCommands: () => [],
		getThinkingLevel: () => "off" as const,
		events: {},
	});
	extension(pi);
	if (sessionStart === undefined) throw new Error("session_start handler was not registered");
	return {
		sessionStart,
		get registrationCount() {
			return registrationCount;
		},
	};
}

function context(mode: ExtensionContext["mode"]): {
	ctx: ExtensionContext;
	notify: ReturnType<typeof vi.fn>;
} {
	const notify = vi.fn();
	return {
		notify,
		ctx: Object.assign({} as ExtensionContext, {
			mode,
			hasUI: mode === "tui" || mode === "rpc",
			cwd: process.cwd(),
			sessionManager: Object.assign({} as ExtensionContext["sessionManager"], {
				getBranch: () => [],
			}),
			ui: Object.assign({} as ExtensionContext["ui"], { notify }),
		}),
	};
}
