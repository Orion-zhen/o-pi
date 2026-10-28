import { act, createElement } from "react";
import { expect, it, vi } from "vitest";
import type { Query, WorkspaceQuery } from "../../../../../src/gui/shared/protocol/queries.ts";
import type { WorkspaceEntry } from "../../../../../src/gui/shared/workspace.ts";
import { useWorkbench, type WorkbenchView } from "../../../../../src/gui/frontend/features/workspace/use-workbench.ts";
import { useReactFixture } from "../../../helpers/react-fixture.ts";

const render = useReactFixture();

it("折叠父目录后刷新跳过隐藏的展开目录，重新展开时恢复读取", async () => {
	const directory = (path: string): WorkspaceEntry => ({ path, name: path.split("/").at(-1) ?? path, kind: "directory" });
	const directories: Record<string, WorkspaceEntry[]> = {
		"": [directory("src")], src: [directory("src/deep")], "src/deep": [directory("src/deep/leaf")], "src/deep/leaf": [],
	};
	const query = vi.fn<Query<WorkspaceQuery>>().mockImplementation(async (request) => {
		if (request.query === "workspaceFiles") return directories[request.path] ?? [];
		if (request.query === "workspaceGit") return null;
		throw new Error(`未请求预览: ${request.query}`);
	});
	let view: WorkbenchView;
	function View() { view = useWorkbench("/workspace", true, false, query as Query<WorkspaceQuery>); return null; }
	await render(createElement(View));
	for (const path of ["src", "src/deep", "src/deep/leaf"]) await act(async () => view.toggleDirectory(path));
	await act(async () => view.toggleDirectory("src"));
	query.mockClear();
	await act(async () => view.refresh());
	const paths = () => query.mock.calls.flatMap(([request]) => request.query === "workspaceFiles" ? [request.path] : []);
	expect(paths()).toEqual([""]);
	query.mockClear();
	await act(async () => view.toggleDirectory("src"));
	expect(paths()).toEqual(["src", "src/deep", "src/deep/leaf"]);
});
