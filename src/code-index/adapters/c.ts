import {
	collectUnits,
	declaratorName,
	firstNamedChildText,
	functionDeclaratorName,
	hasSimpleFunctionDeclarator,
	hasStorageClass,
	rawImport,
	rawUnit,
	walkNamed,
	type UnitRules,
} from "./shared.js";
import type { AnalysisControl } from "../types.js";
import type { LanguageAdapter, RawImport, SyntaxNode } from "./types.js";

const cRules: UnitRules = {
	extract(node) {
		switch (node.type) {
			case "function_definition": {
				const name = functionDeclaratorName(node);
				return name === undefined ? undefined : rawUnit(node, "function", name, undefined, !hasStorageClass(node, "static"));
			}
			case "struct_specifier": {
				const name = node.childForFieldName("name")?.text ?? firstNamedChildText(node, ["type_identifier"]);
				return name === undefined ? undefined : rawUnit(node, "struct", name);
			}
			case "enum_specifier": {
				const name = node.childForFieldName("name")?.text ?? firstNamedChildText(node, ["type_identifier"]);
				return name === undefined ? undefined : rawUnit(node, "enum", name);
			}
			case "type_definition": {
				const name = declaratorName(node);
				return name === undefined ? undefined : rawUnit(node, "typedef", name);
			}
			case "declaration": {
				const name = declaratorName(node) ?? firstNamedChildText(node, ["identifier", "field_identifier"]);
				if (name === undefined) return undefined;
				const functionDeclaration = hasSimpleFunctionDeclarator(node);
				return rawUnit(node, functionDeclaration ? "function" : "declaration", name, undefined, functionDeclaration && !hasStorageClass(node, "static"));
			}
			default:
				return undefined;
		}
	},
	childScope(_node, _unit, current) {
		return current;
	},
	shouldDescend(node) {
		return node.type === "type_definition" || node.type === "declaration";
	},
};

function extractCImports(root: SyntaxNode, control: AnalysisControl): RawImport[] {
	const imports: RawImport[] = [];
	walkNamed(root, (node) => {
		if (node.type !== "preproc_include") return;
		const path = node.childForFieldName("path");
		if (path === null) return;
		if (path.type === "system_lib_string") {
			imports.push({ specifier: path.text.slice(1, -1), startChar: path.startIndex + 1, endChar: path.endIndex - 1, importKind: "external" });
			return;
		}
		if (path.type === "string_literal") {
			const content = path.namedChildren[0];
			if (content !== undefined) imports.push(rawImport(path, content, "relative"));
		}
	}, control);
	return imports;
}

export const cAdapter: LanguageAdapter = {
	language: "c",
	extensions: [".c"],
	grammar: { packageName: "tree-sitter-c", wasmFile: "tree-sitter-c.wasm" },
	extractUnits: (root, control) => collectUnits(root, cRules, control),
	extractImports: extractCImports,
};
