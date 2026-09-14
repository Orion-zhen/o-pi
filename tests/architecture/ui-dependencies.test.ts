import { describe, expect, it } from "vitest";
import { repositoryImportEdges } from "../helpers/import-graph.ts";

const PI_TUI = "@earendil-works/pi-tui";

describe("业务与前端的依赖方向", () => {
	it("harness 不引用应用入口或前端，包含按需加载和类型引用", async () => {
		const edges = await repositoryImportEdges("src/harness");
		expect(edges.filter((edge) =>
			edge.specifier === PI_TUI
			|| (edge.target?.startsWith("src/") && !edge.target.startsWith("src/harness/")),
		)).toEqual([]);
	});

	it("只有 TUI 层直接引用终端组件", async () => {
		const edges = await repositoryImportEdges("src");
		expect(edges.filter((edge) => edge.specifier === PI_TUI && !edge.importer.startsWith("src/tui/"))).toEqual([]);
	});
});
