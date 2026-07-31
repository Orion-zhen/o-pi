import { describe, expect, it } from "vitest";
import { repositoryImportEdges } from "../helpers/import-graph.js";

const PI_TUI = "@earendil-works/pi-tui";

describe("UI dependency architecture", () => {
	it("只允许共享或 feature TUI module 运行时依赖 pi-tui", async () => {
		const edges = await repositoryImportEdges("src", "agent/extensions");
		const staticTargets = new Map<string, string[]>();
		const directPiTui = new Set<string>();
		for (const edge of edges) {
			if (edge.kind !== "static") continue;
			if (edge.specifier === PI_TUI) directPiTui.add(edge.importer);
			if (edge.target === undefined) continue;
			const targets = staticTargets.get(edge.importer) ?? [];
			targets.push(edge.target);
			staticTargets.set(edge.importer, targets);
		}

		const violations = new Set<string>();
		for (const importer of staticTargets.keys()) {
			if (isTuiModule(importer)) continue;
			const pathToPiTui = findPathToPiTui(importer, staticTargets, directPiTui);
			if (pathToPiTui !== undefined) violations.add(pathToPiTui.join(" -> "));
		}
		for (const importer of directPiTui) {
			if (!isTuiModule(importer)) violations.add(`${importer} -> ${PI_TUI}`);
		}
		expect([...violations].sort()).toEqual([]);
	});

	it("extension 不直接引用 pi-tui，且不静态加载 feature TUI", async () => {
		const edges = await repositoryImportEdges("src", "agent/extensions");
		const violations = edges.flatMap((edge) => {
			if (!edge.importer.startsWith("agent/extensions/")) return [];
			if (edge.specifier === PI_TUI) return [`direct:${edge.kind}:${edge.importer}`];
			if (edge.target !== undefined && isFeatureTuiModule(edge.target) && edge.kind === "static") {
				return [`static-feature-tui:${edge.importer}:${edge.specifier}`];
			}
			return [];
		});
		expect(violations.sort()).toEqual([]);
	});
});

function findPathToPiTui(
	start: string,
	targetsByImporter: ReadonlyMap<string, readonly string[]>,
	directPiTui: ReadonlySet<string>,
): string[] | undefined {
	const pending: Array<{ file: string; path: string[] }> = [{ file: start, path: [start] }];
	const visited = new Set<string>();
	while (pending.length > 0) {
		const current = pending.pop();
		if (current === undefined || visited.has(current.file)) continue;
		visited.add(current.file);
		if (directPiTui.has(current.file)) return [...current.path, PI_TUI];
		for (const target of targetsByImporter.get(current.file) ?? []) {
			pending.push({ file: target, path: [...current.path, target] });
		}
	}
	return undefined;
}

function isTuiModule(filePath: string): boolean {
	return filePath.startsWith("src/tui/") || isFeatureTuiModule(filePath);
}

function isFeatureTuiModule(filePath: string): boolean {
	return /^src\/[^/]+\/tui\//u.test(filePath);
}
