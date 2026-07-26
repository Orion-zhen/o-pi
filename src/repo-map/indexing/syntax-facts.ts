import { languageFromPath } from "../../code-index/language-registry.js";
import { isCodeAnalysisControlError, parseDocument, sourceRangeForNode } from "../../code-index/syntax-tree.js";
import { walkNamed } from "../../code-index/adapters/shared.js";
import type { SyntaxNode } from "../../code-index/adapters/types.js";
import type { AnalysisControl, CodeLanguage, ParsedDocument, SourceIndex, SourceRange } from "../../code-index/types.js";

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

function isJavaScriptLanguage(language: CodeLanguage | undefined): boolean {
	return language === "javascript" || language === "jsx" || language === "typescript" || language === "tsx";
}

/** Parse and extract JS-family facts for callers that do not already own a document. */
export async function javascriptSyntaxFacts(filePath: string, text: string): Promise<JavaScriptSyntaxFacts> {
	const language = languageFromPath(filePath);
	if (!isJavaScriptLanguage(language)) return EMPTY_FACTS;
	let document: ParsedDocument | undefined;
	try {
		document = await parseDocument(language, text);
		return javascriptSyntaxFactsFromDocument(filePath, document);
	} catch {
		return EMPTY_FACTS;
	} finally {
		document?.dispose();
	}
}

/** Extract facts from an existing document; malformed roots intentionally produce no facts. */
export function javascriptSyntaxFactsFromDocument(filePath: string, document: ParsedDocument | undefined): JavaScriptSyntaxFacts {
	if (document === undefined || !isJavaScriptLanguage(document.language) || languageFromPath(filePath) !== document.language || document.root.hasError) return EMPTY_FACTS;
	try {
		const { control, root, sourceIndex } = document;
		const constants = collectStringConstants(root, control);
		const facts: JavaScriptSyntaxFacts = {
			registrations: [], reExports: [], defaultExports: [], tests: [], mocks: [], fixtures: [], snapshots: [],
		};
		walkNamed(root, (node) => {
			if (node.type === "call_expression") collectCallFacts(node, constants, facts, sourceIndex, control);
			if (node.type === "export_statement") collectExportFacts(node, facts, sourceIndex);
			if (node.type === "string" || node.type === "template_string") {
				const value = stringValue(node);
				if (value !== undefined && FIXTURE_PATH.test(value)) facts.fixtures.push({ name: value, ...range(sourceIndex, node) });
			}
		}, control);
		return facts;
	} catch (error) {
		if (isCodeAnalysisControlError(error)) throw error;
		return EMPTY_FACTS;
	}
}

function collectStringConstants(root: SyntaxNode, control: AnalysisControl): ReadonlyMap<string, string> {
	const constants = new Map<string, string>();
	walkNamed(root, (node) => {
		if (node.type !== "variable_declarator") return;
		const name = node.childForFieldName("name");
		const value = node.childForFieldName("value");
		const literal = value === null ? undefined : stringValue(value);
		if (name?.type === "identifier" && literal !== undefined) constants.set(name.text, literal);
	}, control);
	return constants;
}

function collectCallFacts(
	node: SyntaxNode,
	constants: ReadonlyMap<string, string>,
	facts: JavaScriptSyntaxFacts,
	sourceIndex: SourceIndex,
	control: AnalysisControl,
): void {
	const callable = node.childForFieldName("function") ?? node.namedChildren[0];
	const args = node.childForFieldName("arguments") ?? node.namedChildren.find((child) => child.type === "arguments");
	if (callable === undefined || args === undefined) return;
	const callee = propertyName(callable, control);
	const base = baseCalleeName(callable, control);
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
			...range(sourceIndex, node),
		});
	}

	if (base === "describe" || base === "it" || base === "test") {
		const name = arguments_[0] === undefined ? undefined : stringValue(arguments_[0]);
		if (name !== undefined) facts.tests.push({ name, ...range(sourceIndex, node) });
	}
	if (((base === "vi" || base === "jest") && callee === "mock") || (base === "mock" && callee === "patch") || base === "patch") {
		const target = arguments_[0] === undefined ? undefined : stringValue(arguments_[0]);
		if (target !== undefined) facts.mocks.push({ name: target, ...range(sourceIndex, node) });
	}
	if (callee === "toMatchSnapshot" || callee === "toMatchInlineSnapshot") {
		facts.snapshots.push({ name: arguments_[0] === undefined ? "snapshot" : stringValue(arguments_[0]) ?? "snapshot", ...range(sourceIndex, node) });
	}
}

function collectExportFacts(node: SyntaxNode, facts: JavaScriptSyntaxFacts, sourceIndex: SourceIndex): void {
	const targetNode = node.namedChildren.find((child) => child.type === "string");
	const target = targetNode === undefined ? undefined : stringValue(targetNode);
	if (target !== undefined) {
		const clause = node.namedChildren.find((child) => child.type === "export_clause");
		const names = clause === undefined
			? "*" as const
			: new Set(clause.namedChildren.flatMap((specifier) => specifier.namedChildren[0]?.text ?? []));
		facts.reExports.push({ target, names, ...range(sourceIndex, node) });
	}
	if (node.children.some((child) => child.type === "default")) facts.defaultExports.push(range(sourceIndex, node));
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

function propertyName(node: SyntaxNode, control: AnalysisControl): string | undefined {
	let current: SyntaxNode | undefined = node;
	while (current !== undefined) {
		control.check();
		if (current.type === "identifier" || current.type === "property_identifier") return current.text;
		if (current.type === "member_expression") return current.childForFieldName("property")?.text ?? current.namedChildren.at(-1)?.text;
		if (current.type !== "call_expression") return undefined;
		current = current.childForFieldName("function") ?? current.namedChildren[0];
	}
	return undefined;
}

function baseCalleeName(node: SyntaxNode, control: AnalysisControl): string | undefined {
	let current: SyntaxNode | undefined = node;
	while (current !== undefined) {
		control.check();
		if (current.type === "identifier") return current.text;
		if (current.type !== "member_expression" && current.type !== "call_expression") return undefined;
		current = current.childForFieldName("object") ?? current.childForFieldName("function") ?? current.namedChildren[0];
	}
	return undefined;
}

function range(sourceIndex: SourceIndex, node: SyntaxNode): SourceRange {
	return sourceRangeForNode(sourceIndex, node);
}
