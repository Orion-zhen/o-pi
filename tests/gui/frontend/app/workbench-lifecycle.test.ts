import { act, createElement } from "react";
import { expect, it, vi } from "vitest";
import type { GuiConnection } from "../../../../src/gui/shared/protocol/connection.ts";
import type { GuiEvent } from "../../../../src/gui/shared/protocol/events.ts";
import { connectGui } from "../../../../src/gui/frontend/connection/connection.ts";
import { useGui } from "../../../../src/gui/frontend/app/use-gui.ts";
import { readGuiDefaults } from "../../../../src/gui/host/config/preferences.ts";
import { useReactFixture } from "../../helpers/react-fixture.ts";

vi.mock("../../../../src/gui/frontend/connection/connection.ts", () => ({ connectGui: vi.fn() }));
const render = useReactFixture(() => vi.resetAllMocks());

it("连接就绪但未收到工作区时不读取文件，工作区失效与恢复控制后续读取", async () => {
	vi.stubGlobal("localStorage", { getItem: () => null });
	vi.stubGlobal("sessionStorage", { getItem: () => null });
	Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false }) });
	const defaults = readGuiDefaults();
	const listeners = new Set<(event: GuiEvent) => void>();
	const connection: GuiConnection = {
		send: async () => { throw new Error("未提供操作"); },
		query: async () => { throw new Error("未提供查询"); },
		subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		close() {},
	};
	vi.spyOn(connection, "send").mockResolvedValue(undefined);
	const query = vi.spyOn(connection, "query").mockImplementation(async (request) => {
		switch (request.query) {
			case "guiConfig": return { state: "ready", path: "/gui.jsonc", content: "", defaults, value: defaults };
			case "availableVersion": case "workspaceGit": return null;
			case "workspaceFiles": return [];
			default: throw new Error(`未提供查询: ${request.query}`);
		}
	});
	const workspaceQueries = () => query.mock.calls.map(([request]) => request)
		.filter((request) => request.query === "workspaceFiles" || request.query === "workspaceGit" || request.query === "previewFile");
	vi.mocked(connectGui).mockImplementation((onStatus) => { onStatus("connected"); return connection; });
	const receive = (event: GuiEvent) => act(async () => { for (const listener of listeners) listener(event); });
	let gui: ReturnType<typeof useGui>;
	const current = () => gui;
	function View() { gui = useGui(); return null; }
	await render(createElement(View));
	expect(current().connected).toBe(true);
	expect(current().cwd).toBe("");
	expect(workspaceQueries()).toEqual([]);

	await receive({ type: "workspaceRoot", path: "/workspace" });
	expect(workspaceQueries()).toHaveLength(2);
	expect(current().workbench.directories[""]).toEqual({ state: "ready", value: [] });
	expect(current().workbench.git).toEqual({ state: "ready", value: null });

	query.mockClear();
	await receive({ type: "workspaces", value: [{ path: "/workspace", exists: false }] });
	expect(workspaceQueries()).toEqual([]);

	await receive({ type: "workspaces", value: [{ path: "/workspace", exists: true }] });
	expect(workspaceQueries()).toHaveLength(2);
	expect(current().workbench.directories[""]).toEqual({ state: "ready", value: [] });
	expect(current().workbench.git).toEqual({ state: "ready", value: null });
});
