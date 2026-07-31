import { describe, expect, it } from "vitest";
import { repositoryImportEdges, type ImportEdge } from "../helpers/import-graph.js";

const TOOL_NAMES = new Set(["ls", "read", "write", "edit", "find", "grep"]);

type Rule = "filesystem-upward" | "tool-sibling" | "tool-data-plane" | "external-tool-internal";

describe("file-tools import architecture", () => {
	it("matches the final dependency matrix without legacy exceptions", async () => {
		const edges = await repositoryImportEdges("src");
		const violations = [...edges.flatMap(classifyViolations), ...findTransitiveToolSiblingViolations(edges)].sort();
		expect(violations).toEqual([]);
	});
});

function classifyViolations(edge: ImportEdge): string[] {
	const rules: Rule[] = [];
	if (edge.importer.startsWith("src/filesystem/") && isFilesystemUpwardImport(edge)) rules.push("filesystem-upward");
	if (isToolSiblingImport(edge)) rules.push("tool-sibling");
	if (isToolImplementation(edge.importer) && bypassesFilesystemPlane(edge)) rules.push("tool-data-plane");
	if (isExternalSubsystem(edge.importer)
		&& edge.target?.startsWith("src/file-tools/")
		&& edge.target !== "src/file-tools/config.ts") rules.push("external-tool-internal");
	return rules.map((rule) => `${rule}:${edge.importer}:${edge.specifier}`);
}

function isFilesystemUpwardImport(edge: ImportEdge): boolean {
	if (edge.specifier.startsWith("@earendil-works/pi-")) return true;
	return edge.target !== undefined && [
		"src/file-tools/",
		"src/lsp/",
		"src/skill-context/",
		"src/code-index/",
	].some((prefix) => edge.target?.startsWith(prefix));
}

function findTransitiveToolSiblingViolations(edges: ImportEdge[]): string[] {
	const targetsByImporter = new Map<string, string[]>();
	for (const edge of edges) {
		if (edge.target === undefined || !edge.target.startsWith("src/")) continue;
		const targets = targetsByImporter.get(edge.importer) ?? [];
		targets.push(edge.target);
		targetsByImporter.set(edge.importer, targets);
	}
	const violations = new Set<string>();
	for (const tool of TOOL_NAMES) {
		const pending = [...targetsByImporter.keys()].filter((file) => finalToolName(file) === tool);
		const visited = new Set<string>();
		while (pending.length > 0) {
			const current = pending.pop();
			if (current === undefined || visited.has(current)) continue;
			visited.add(current);
			for (const target of targetsByImporter.get(current) ?? []) {
				const targetTool = finalToolName(target);
				if (targetTool !== undefined && targetTool !== tool) {
					violations.add(`tool-sibling-transitive:${tool}->${targetTool}`);
					continue;
				}
				pending.push(target);
			}
		}
	}
	return [...violations];
}

function isToolSiblingImport(edge: ImportEdge): boolean {
	const importerTool = finalToolName(edge.importer);
	const targetTool = edge.target === undefined ? undefined : finalToolName(edge.target);
	return importerTool !== undefined && targetTool !== undefined && importerTool !== targetTool;
}

function isToolImplementation(filePath: string): boolean {
	return finalToolName(filePath) !== undefined;
}

function bypassesFilesystemPlane(edge: ImportEdge): boolean {
	if (edge.specifier === "node:path" || edge.specifier.startsWith("node:fs")) return true;
	if (edge.target === undefined) return false;
	return edge.target.startsWith("src/file-tools/ignore/")
		|| edge.target.startsWith("src/lsp/")
		|| edge.target.startsWith("src/skill-context/");
}

function isExternalSubsystem(filePath: string): boolean {
	return ["src/lsp/", "src/skill-context/", "src/approval/", "src/code-index/"]
		.some((prefix) => filePath.startsWith(prefix));
}

function finalToolName(filePath: string): string | undefined {
	const match = /^src\/file-tools\/([^/]+)\//u.exec(filePath);
	const name = match?.[1];
	return name !== undefined && TOOL_NAMES.has(name) ? name : undefined;
}
