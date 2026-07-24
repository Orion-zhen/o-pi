import { describe, expect, it } from "vitest";

import { adapterFromPath } from "../../src/code-index/language-registry.js";
import { buildLineIndex } from "../../src/code-index/parser.js";
import { parseSyntaxTree } from "../../src/code-index/syntax-tree.js";

describe.each([
	{
		filePath: "adapter.js",
		text: "class Service { run() {} }\nfunction top() {}\n",
		units: ["class:Service", "method:Service.run", "function:top"],
		imports: [],
	},
	{
		filePath: "adapter.jsx",
		text: "import View from './view';\nfunction Page() { return <View />; }\n",
		units: ["function:Page"],
		imports: ["./view"],
	},
	{
		filePath: "adapter.ts",
		text: "import { load } from './loader';\nexport interface Config {}\nexport function run() {}\n",
		units: ["interface:Config", "function:run"],
		imports: ["./loader"],
	},
	{
		filePath: "adapter.tsx",
		text: "export const view = () => <main />;\n",
		units: ["declaration:view"],
		imports: [],
	},
	{
		filePath: "adapter.py",
		text: "from app.core import run\nclass Service:\n  def serve(self):\n    pass\n",
		units: ["class:Service", "function:Service.serve"],
		imports: ["app.core"],
	},
	{
		filePath: "adapter.go",
		text: "package adapter\nimport \"example/core\"\ntype Service struct{}\nfunc Run() {}\n",
		units: ["type:Service", "function:Run"],
		imports: ["example/core"],
	},
	{
		filePath: "adapter.rs",
		text: "use crate::core::run;\nstruct Service;\nimpl Service { fn run(&self) {} }\n",
		units: ["type:Service", "module:Service", "function:Service.run"],
		imports: ["crate::core::run"],
	},
	{
		filePath: "adapter.c",
		text: "#include <stdio.h>\n# include \"point.h\"\n// #include <ignored.h>\ntypedef struct Point { int x; } Point;\nenum Color { Red };\nint add(int left, int right) { const char *text = \"#include <not-an-import.h>\"; int local = left + right; return local; }\nint answer = 42;\n",
		units: ["typedef:Point", "struct:Point", "enum:Color", "function:add", "declaration:answer"],
		imports: ["stdio.h", "point.h"],
	},
	{
		filePath: "adapter.hpp",
		text: "#include <vector>\n#include \"detail.hpp\"\nnamespace app {\nclass Service { public: Service() {} int run(int value) { int local = value; return local; } int pending(); };\nstruct Data { void load(); int value; };\nenum Color { Red };\nusing Number = int;\ntypedef int Old;\n}\nvoid freeFunction() {}\n",
		units: [
			"namespace:app",
			"class:app.Service",
			"method:app.Service.Service",
			"method:app.Service.run",
			"method:app.Service.pending",
			"struct:app.Data",
			"method:app.Data.load",
			"enum:app.Color",
			"alias:app.Number",
			"typedef:app.Old",
			"function:freeFunction",
		],
		imports: ["vector", "detail.hpp"],
	},
])("$filePath adapter", ({ filePath, text, units, imports }) => {
	it("extracts units and imports through the adapter contract", () => {
		const adapter = adapterFromPath(filePath);
		if (adapter === undefined) throw new Error(`missing adapter for ${filePath}`);
		const root = parseSyntaxTree(adapter.language, text);
		if (root === undefined) throw new Error(`missing syntax tree for ${adapter.language}`);
		expect(adapter.extractUnits(root).map((unit) => `${unit.kind}:${unit.qualifiedName}`)).toEqual(units);
		expect(adapter.collectImports(text, buildLineIndex(text)).map((item) => item.specifier)).toEqual(imports);
	});
});
