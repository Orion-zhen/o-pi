import { describe, expect, it } from "vitest";
import { SymbolKind, type DocumentSymbol, type SymbolInformation } from "vscode-languageserver-protocol";

import { compactOutline } from "../../src/lsp/symbols.js";

const nestedSymbols = [symbol("root-a", 0, [
	symbol("child-a", 1, [
		symbol("grandchild-a", 2, [symbol("deep-a", 3)]),
	]),
	symbol("child-b", 4),
]), symbol("root-b", 5)];

describe("lsp symbols", () => {
	it.each([
		["zero budget", 0, []],
		["nested budget", 3, [{ name: "root-a", children: [{ name: "child-a", children: [{ name: "grandchild-a" }] }] }]],
		["deep DFS budget", 4, [{ name: "root-a", children: [{ name: "child-a", children: [{ name: "grandchild-a", children: [{ name: "deep-a" }] }] }] }]],
		["root continuation", 6, [
			{ name: "root-a", children: [{ name: "child-a", children: [{ name: "grandchild-a", children: [{ name: "deep-a" }] }] }, { name: "child-b" }] },
			{ name: "root-b" },
		]],
	] as const)("%s 全树不超过 max_symbols", (_label, maxSymbols, expected) => {
		const outline = compactOutline(nestedSymbols, maxSymbols);
		expect(outline).toMatchObject(expected);
		expect(countOutline(outline)).toBe(Math.min(maxSymbols, 6));
	});

	it("扁平 SymbolInformation 保持原始顺序并共享预算", () => {
		const symbols: SymbolInformation[] = [flatSymbol("first", 0), flatSymbol("second", 1), flatSymbol("third", 2)];
		expect(compactOutline(symbols, 2).map((item) => item.name)).toEqual(["first", "second"]);
	});
});

function symbol(name: string, line: number, children?: DocumentSymbol[]): DocumentSymbol {
	const range = { start: { line, character: 0 }, end: { line, character: name.length } };
	return {
		name,
		kind: SymbolKind.Function,
		range,
		selectionRange: range,
		...(children === undefined ? {} : { children }),
	};
}

function flatSymbol(name: string, line: number): SymbolInformation {
	return {
		name,
		kind: SymbolKind.Function,
		location: {
			uri: `file:///workspace/${name}.ts`,
			range: { start: { line, character: 0 }, end: { line, character: name.length } },
		},
	};
}

function countOutline(items: ReturnType<typeof compactOutline>): number {
	return items.reduce((total, item) => total + 1 + countOutline(item.children ?? []), 0);
}
