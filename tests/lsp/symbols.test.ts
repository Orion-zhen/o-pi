import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { SymbolKind, type DocumentSymbol, type SymbolInformation } from "vscode-languageserver-protocol";

import { findEnclosingSymbol, modifiedSymbolRanges, remainingSymbols } from "../../src/lsp/analysis/symbols.js";

const workspace = path.resolve("workspace");

describe("lsp symbols", () => {
	it.each([
		["zero budget", 0, 3, []],
		["visible majority", 3, 5, []],
		["remaining roots only", 2, 3, ["root-c", "root-d"]],
		["max_symbols", 1, 3, ["root-c"]],
	] as const)("%s only returns unseen top-level symbols", (_label, maxSymbols, endLine, expected) => {
		const symbols = [symbol("root-a", 0, [symbol("child-a", 1)]), symbol("root-b", 2), symbol("root-c", 4), symbol("root-d", 6)];
		expect(remainingSymbols(symbols, 1, endLine, maxSymbols).map((item) => item.name)).toEqual(expected);
	});

	it("扁平 SymbolInformation 保持原始顺序且排除嵌套 symbol", () => {
		const symbols: SymbolInformation[] = [
			flatSymbol("first", 0),
			flatSymbol("nested", 1, "first"),
			flatSymbol("second", 2),
		];
		expect(remainingSymbols(symbols, 1, 1, 2).map((item) => item.name)).toEqual(["second"]);
	});

	it.each([
		["declaration outside visible range", 2, 2, "demo"],
		["declaration visible", 1, 2, undefined],
		["whole symbol visible", 1, 3, undefined],
	] as const)("enclosing symbol only reports a hidden declaration for a partial range: %s", (_label, startLine, endLine, name) => {
		const symbols = [symbol("demo", 0, undefined, 2)];
		expect(findEnclosingSymbol(symbols, startLine, endLine)?.name).toBe(name);
	});

	it("找到每个修改范围所属的最小 symbol", () => {
		const symbols = [symbol("outer", 0, [symbol("inner", 1, undefined, 4)], 6)];
		expect(modifiedSymbolRanges(symbols, [
			{ startLine: 3, endLine: 3 },
			{ startLine: 6, endLine: 6 },
		])).toMatchObject([
			{ name: "inner", line: 2, end_line: 5 },
			{ name: "outer", line: 1, end_line: 7 },
		]);
	});

	it("nested symbol with a visible declaration does not fall back to an outer symbol", () => {
		const symbols = [symbol("outer", 0, [symbol("inner", 1, undefined, 3)], 4)];
		expect(findEnclosingSymbol(symbols, 2, 2)).toBeUndefined();
	});
});

function symbol(name: string, line: number, children?: DocumentSymbol[], endLine = line): DocumentSymbol {
	const range = { start: { line, character: 0 }, end: { line: endLine, character: name.length } };
	return {
		name,
		kind: SymbolKind.Function,
		range,
		selectionRange: range,
		...(children === undefined ? {} : { children }),
	};
}

function flatSymbol(name: string, line: number, containerName?: string): SymbolInformation {
	return {
		name,
		kind: SymbolKind.Function,
		...(containerName === undefined ? {} : { containerName }),
		location: {
			uri: pathToFileURL(path.join(workspace, `${name}.ts`)).toString(),
			range: { start: { line, character: 0 }, end: { line, character: name.length } },
		},
	};
}
