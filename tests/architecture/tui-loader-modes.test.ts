import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { presentation } from "../../src/tui/extensions.ts";
import bashToolExtension from "../../src/harness/extensions/bash-tool.ts";
import { createFileToolsExtension } from "../../src/harness/extensions/file-tools.ts";
import { createPruneExtension } from "../../src/harness/extensions/prune.ts";
import { createSkillContextExtension } from "../../src/harness/extensions/skill-context.ts";
import { createSubagentExtension } from "../../src/harness/extensions/subagent.ts";
import { createWebToolsExtension } from "../../src/harness/extensions/web-tools.ts";

const bashRendererLoad = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../src/tui/chat/bash-tool/renderer.ts", async (importOriginal) => {
	bashRendererLoad.count += 1;
	return importOriginal<typeof import("../../src/tui/chat/bash-tool/renderer.ts")>();
});

type ExtensionRegistration = (pi: ExtensionAPI) => void;
type SessionStartHandler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;

interface LoaderCase {
	name: string;
	create(): {
		extension: ExtensionRegistration;
		loadCount(): number;
	};
}

const cases: LoaderCase[] = [
	loaderCase("prune", () => import("../../src/tui/chat/prune/index.ts"), createPruneExtension),
	loaderCase("file", () => import("../../src/tui/chat/file-tools/index.ts"), (load) => createFileToolsExtension({ renderers: load })),
	loaderCase("web", async () => {
		const [webfetch, websearch] = await Promise.all([
			import("../../src/tui/chat/web-tools/webfetch.ts"),
			import("../../src/tui/chat/web-tools/websearch.ts"),
		]);
		return { ...webfetch, ...websearch };
	}, (load) => createWebToolsExtension(async () => {
		throw new Error("runtime must not load during session start");
	}, load)),
	loaderCase("skill", () => import("../../src/tui/chat/skill-context/renderer.ts"), createSkillContextExtension),
	loaderCase("subagent", () => import("../../src/tui/chat/subagent/adapter.ts"), createSubagentExtension),
];

function loaderCase<Renderer>(
	name: string,
	loadRenderer: () => Promise<Renderer>,
	createExtension: (load: () => Promise<Renderer>) => ExtensionRegistration,
): LoaderCase {
	return {
		name,
		create() {
			let calls = 0;
			const load = async () => {
				calls += 1;
				return loadRenderer();
			};
			return { extension: createExtension(load), loadCount: () => calls };
		},
	};
}

it("bash 正式入口只在 TUI 模式加载真实 renderer，并只加载一次", async () => {
	const harness = register((pi) => bashToolExtension(pi, presentation.bashTool));
	const coreRegistrations = harness.registrationCount;
	for (const mode of ["rpc", "json", "print"] as const) {
		await harness.sessionStart({}, context(mode).ctx);
	}
	expect(bashRendererLoad.count).toBe(0);
	expect(harness.registrationCount).toBe(coreRegistrations);
	await harness.sessionStart({}, context("tui").ctx);
	await harness.sessionStart({}, context("tui").ctx);
	expect(bashRendererLoad.count).toBe(1);
	expect(harness.registrationCount).toBe(coreRegistrations + 1);
});

describe.each(cases)("$name TUI loader", ({ create }) => {
	it("rpc/json/print 不加载，重复 TUI start 只加载一次", async () => {
		const value = create();
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
		events: createEventBus(),
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
