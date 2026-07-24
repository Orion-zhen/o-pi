import type ParserModule from "tree-sitter";

import { languageFromPath } from "../code-index/language-registry.js";
import { loadTreeSitterRuntime } from "../code-index/tree-sitter-loader.js";
import type { SourceRange } from "../code-index/types.js";

type SyntaxNode = ParserModule.SyntaxNode;

export interface RegistrationFact extends SourceRange {
	name: string;
	type: "command" | "tool" | "plugin";
	dynamic: boolean;
}

export interface ReExportFact extends SourceRange {
	target: string;
	names: "*" | ReadonlySet<string>;
}

export interface NamedSyntaxFact extends SourceRange {
	name: string;
}

export interface JavaScriptSyntaxFacts {
	registrations: RegistrationFact[];
	reExports: ReExportFact[];
	defaultExports: SourceRange[];
	tests: NamedSyntaxFact[];
	mocks: NamedSyntaxFact[];
	fixtures: NamedSyntaxFact[];
	snapshots: NamedSyntaxFact[];
}

const EMPTY_FACTS: JavaScriptSyntaxFacts = {
	registrations: [],
	reExports: [],
	defaultExports: [],
	tests: [],
	mocks: [],
	fixtures: [],
	snapshots: [],
};
const FIXTURE_PATH = /(?:^|\/)(?:__fixtures__|fixtures?|testdata)(?:\/|$)/iu;

/** Extract JS-family facts from a real syntax tree; malformed files simply produce no facts. */
export function javascriptSyntaxFacts(filePath: string, text: string): JavaScriptSyntaxFacts {
	const language = languageFromPath(filePath);
	if (language !== "javascript" && language !== "jsx" && language !== "typescript" && language !== "tsx") return EMPTY_FACTS;
	try {
		const runtime = loadTreeSitterRuntime(language);
		if (runtime === undefined) return EMPTY_FACTS;
		const parser = new runtime.Parser();
		parser.setLanguage(runtime.language);
		const root = parser.parse(text).rootNode;
		if (root.hasError) return EMPTY_FACTS;

		const constants = collectStringConstants(root);
		const facts: JavaScriptSyntaxFacts = {
			registrations: [], reExports: [], defaultExports: [], tests: [], mocks: [], fixtures: [], snapshots: [],
		};
		walk(root, (node) => {
			if (node.type === "call_expression") collectCallFacts(node, constants, facts);
			if (node.type === "export_statement") collectExportFacts(node, facts);
			if (node.type === "string" || node.type === "template_string") {
				const value = stringValue(node);
				if (value !== undefined && FIXTURE_PATH.test(value)) facts.fixtures.push({ name: value, ...range(node) });
			}
		});
		return facts;
	} catch {
		return EMPTY_FACTS;
	}
}

function collectStringConstants(root: SyntaxNode): ReadonlyMap<string, string> {
	const constants = new Map<string, string>();
	walk(root, (node) => {
		if (node.type !== "variable_declarator") return;
		const name = node.childForFieldName("name");
		const value = node.childForFieldName("value");
		const literal = value === null ? undefined : stringValue(value);
		if (name?.type === "identifier" && literal !== undefined) constants.set(name.text, literal);
	});
	return constants;
}

function collectCallFacts(node: SyntaxNode, constants: ReadonlyMap<string, string>, facts: JavaScriptSyntaxFacts): void {
	const callable = node.childForFieldName("function") ?? node.namedChildren[0];
	const args = node.childForFieldName("arguments") ?? node.namedChildren.find((child) => child.type === "arguments");
	if (callable === undefined || args === undefined) return;
	const callee = propertyName(callable);
	const base = baseCalleeName(callable);
	const arguments_ = args.namedChildren;

	const registrationType = callee === "registerCommand" ? "command"
		: callee === "registerTool" ? "tool"
			: callee === "registerPlugin" || callee === "registerExtension" ? "plugin" : undefined;
	if (registrationType !== undefined) {
		const nameNode = registrationType === "tool" ? objectProperty(arguments_[0], "name") : arguments_[0];
		const value = nameNode === undefined ? undefined : staticString(nameNode, constants);
		if (nameNode !== undefined) facts.registrations.push({
			name: value ?? nameNode.text,
			type: registrationType,
			dynamic: value === undefined,
			...range(node),
		});
	}

	if (base === "describe" || base === "it" || base === "test") {
		const name = arguments_[0] === undefined ? undefined : stringValue(arguments_[0]);
		if (name !== undefined) facts.tests.push({ name, ...range(node) });
	}
	if (((base === "vi" || base === "jest") && callee === "mock") || (base === "mock" && callee === "patch") || base === "patch") {
		const target = arguments_[0] === undefined ? undefined : stringValue(arguments_[0]);
		if (target !== undefined) facts.mocks.push({ name: target, ...range(node) });
	}
	if (callee === "toMatchSnapshot" || callee === "toMatchInlineSnapshot") {
		facts.snapshots.push({ name: arguments_[0] === undefined ? "snapshot" : stringValue(arguments_[0]) ?? "snapshot", ...range(node) });
	}
}

function collectExportFacts(node: SyntaxNode, facts: JavaScriptSyntaxFacts): void {
	const targetNode = node.namedChildren.find((child) => child.type === "string");
	const target = targetNode === undefined ? undefined : stringValue(targetNode);
	if (target !== undefined) {
		const clause = node.namedChildren.find((child) => child.type === "export_clause");
		const names = clause === undefined
			? "*" as const
			: new Set(clause.namedChildren.flatMap((specifier) => specifier.namedChildren[0]?.text ?? []));
		facts.reExports.push({ target, names, ...range(node) });
	}
	if (node.children.some((child) => child.type === "default")) facts.defaultExports.push(range(node));
}

function objectProperty(node: SyntaxNode | undefined, key: string): SyntaxNode | undefined {
	if (node?.type !== "object") return undefined;
	for (const pair of node.namedChildren) {
		if (pair.type !== "pair") continue;
		const name = pair.childForFieldName("key") ?? pair.namedChildren[0];
		if (name?.text === key) return pair.childForFieldName("value") ?? pair.namedChildren[1];
	}
	return undefined;
}

function staticString(node: SyntaxNode, constants: ReadonlyMap<string, string>): string | undefined {
	return stringValue(node) ?? (node.type === "identifier" ? constants.get(node.text) : undefined);
}

function stringValue(node: SyntaxNode): string | undefined {
	if (node.type !== "string" && node.type !== "template_string") return undefined;
	if (node.namedChildren.some((child) => child.type === "template_substitution")) return undefined;
	return node.text.slice(1, -1);
}

function propertyName(node: SyntaxNode): string | undefined {
	if (node.type === "identifier" || node.type === "property_identifier") return node.text;
	if (node.type === "member_expression") return node.childForFieldName("property")?.text ?? node.namedChildren.at(-1)?.text;
	if (node.type === "call_expression") {
		const callable = node.childForFieldName("function") ?? node.namedChildren[0];
		return callable === undefined ? undefined : propertyName(callable);
	}
	return undefined;
}

function baseCalleeName(node: SyntaxNode): string | undefined {
	if (node.type === "identifier") return node.text;
	if (node.type === "member_expression" || node.type === "call_expression") {
		const child = node.childForFieldName("object") ?? node.childForFieldName("function") ?? node.namedChildren[0];
		return child === undefined ? undefined : baseCalleeName(child);
	}
	return undefined;
}

function range(node: SyntaxNode): SourceRange {
	return {
		startLine: node.startPosition.row + 1,
		endLine: node.endPosition.row + 1,
		startByte: node.startIndex,
		endByte: node.endIndex,
	};
}

function walk(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
	visit(node);
	for (const child of node.namedChildren) walk(child, visit);
}
