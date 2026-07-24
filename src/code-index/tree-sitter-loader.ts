import { createRequire } from "node:module";
import type ParserModule from "tree-sitter";

import type { GrammarSpec, LanguageAdapter } from "./adapters/types.js";
import type { CodeLanguage, ParseFailure } from "./types.js";

type TreeSitterLanguage = ParserModule.Language;
type ParserConstructor = typeof ParserModule;
export type TreeSitterParser = InstanceType<ParserConstructor>;

export interface TreeSitterRuntime {
	Parser: ParserConstructor;
	language: TreeSitterLanguage;
	grammar: GrammarSpec;
}

export type TreeSitterRuntimeResult =
	| { runtime: TreeSitterRuntime }
	| { failure: ParseFailure };

export type TreeSitterParserResult =
	| { parser: TreeSitterParser }
	| { failure: ParseFailure };

export const DEFAULT_PARSE_TIMEOUT_MICROS = 250_000;

const require = createRequire(import.meta.url);
const runtimes = new Map<string, TreeSitterRuntimeResult>();
const grammars = new Map<string, TreeSitterLanguage | ParseFailure>();
const parsers = new Map<string, TreeSitterParserResult>();
let parserConstructor: ParserConstructor | undefined;
let parserFailure: ParseFailure | undefined;

/** Load a grammar/runtime descriptor without consulting the language registry. */
export function loadTreeSitterRuntimeForAdapter(adapter: Pick<LanguageAdapter, "grammar">): TreeSitterRuntimeResult {
	return loadTreeSitterRuntimeForGrammar(adapter.grammar);
}

/** Runtime and grammar failures are cached as serializable results. */
export function loadTreeSitterRuntimeForGrammar(spec: GrammarSpec): TreeSitterRuntimeResult {
	const key = descriptorKey(spec);
	const cached = runtimes.get(key);
	if (cached !== undefined) return cached;

	const Parser = loadParserConstructor();
	if (Parser === undefined) {
		const result: TreeSitterRuntimeResult = { failure: parserFailure ?? failure("RUNTIME_UNAVAILABLE", "Tree-sitter runtime is unavailable.") };
		runtimes.set(key, result);
		return result;
	}
	const grammar = loadGrammarResult(spec);
	if ("failure" in grammar) {
		runtimes.set(key, grammar);
		return grammar;
	}
	const result: TreeSitterRuntimeResult = { runtime: { Parser, language: grammar.language, grammar: spec } };
	runtimes.set(key, result);
	return result;
}

/** Cache one parser per grammar descriptor and configure its timeout once. */
export function loadTreeSitterParser(
	adapter: Pick<LanguageAdapter, "grammar">,
	timeoutMicros = DEFAULT_PARSE_TIMEOUT_MICROS,
): TreeSitterParserResult {
	const key = `${descriptorKey(adapter.grammar)}\0${timeoutMicros}`;
	const cached = parsers.get(key);
	if (cached !== undefined) return cached;
	const runtimeResult = loadTreeSitterRuntimeForAdapter(adapter);
	if ("failure" in runtimeResult) {
		parsers.set(key, runtimeResult);
		return runtimeResult;
	}
	let parser: TreeSitterParser;
	try {
		parser = new runtimeResult.runtime.Parser();
	} catch {
		const result: TreeSitterParserResult = { failure: failure("PARSER_INITIALIZATION_FAILED", "Tree-sitter parser could not be initialized.") };
		parsers.set(key, result);
		return result;
	}
	try {
		parser.setLanguage(runtimeResult.runtime.language);
		parser.setTimeoutMicros(timeoutMicros);
	} catch {
		const result: TreeSitterParserResult = { failure: failure("GRAMMAR_INCOMPATIBLE", "Tree-sitter grammar is incompatible with the runtime.") };
		parsers.set(key, result);
		return result;
	}
	const result: TreeSitterParserResult = { parser };
	parsers.set(key, result);
	return result;
}

/** Descriptor loader; the string overload is retained only for unsupported legacy language calls. */
export function loadTreeSitterRuntime(spec: GrammarSpec | LanguageAdapter): TreeSitterRuntimeResult;
export function loadTreeSitterRuntime(spec: CodeLanguage): TreeSitterRuntime | undefined;
export function loadTreeSitterRuntime(spec: GrammarSpec | LanguageAdapter | CodeLanguage): TreeSitterRuntimeResult | TreeSitterRuntime | undefined {
	if (typeof spec === "string") return undefined;
	return "grammar" in spec ? loadTreeSitterRuntimeForAdapter(spec) : loadTreeSitterRuntimeForGrammar(spec);
}

/** Legacy grammar-shaped wrapper; failures remain cached by the structured loader. */
export function loadGrammar(spec: GrammarSpec): TreeSitterLanguage | undefined {
	const result = loadGrammarResult(spec);
	return "language" in result ? result.language : undefined;
}

function loadGrammarResult(spec: GrammarSpec): { language: TreeSitterLanguage } | { failure: ParseFailure } {
	const key = descriptorKey(spec);
	const cached = grammars.get(key);
	if (cached !== undefined) return isParseFailure(cached) ? { failure: cached } : { language: cached };

	try {
		const moduleValue: unknown = require(spec.packageName);
		const exported = spec.exportName === undefined ? moduleValue : property(moduleValue, spec.exportName);
		if (!isTreeSitterLanguage(exported)) {
			const result = failure("GRAMMAR_EXPORT_INVALID", `Tree-sitter grammar export for ${descriptorLabel(spec)} is invalid.`);
			grammars.set(key, result);
			return { failure: result };
		}
		grammars.set(key, exported);
		return { language: exported };
	} catch (error) {
		const code = isMissingModuleError(error, spec.packageName) ? "GRAMMAR_UNAVAILABLE" : "GRAMMAR_INCOMPATIBLE";
		const message = code === "GRAMMAR_UNAVAILABLE"
			? `Tree-sitter grammar ${descriptorLabel(spec)} is unavailable.`
			: `Tree-sitter grammar ${descriptorLabel(spec)} is incompatible with the runtime.`;
		const result = failure(code, message);
		grammars.set(key, result);
		return { failure: result };
	}
}

function loadParserConstructor(): ParserConstructor | undefined {
	if (parserConstructor !== undefined) return parserConstructor;
	if (parserFailure !== undefined) return undefined;
	try {
		const moduleValue: unknown = require("tree-sitter");
		if (!isParserConstructor(moduleValue)) throw new Error("invalid runtime export");
		parserConstructor = moduleValue;
		return parserConstructor;
	} catch {
		parserFailure = failure("RUNTIME_UNAVAILABLE", "Tree-sitter runtime is unavailable.");
		return undefined;
	}
}

function descriptorKey(spec: GrammarSpec): string {
	return `${spec.packageName}\0${spec.exportName ?? ""}`;
}

function descriptorLabel(spec: GrammarSpec): string {
	return `${spec.packageName}${spec.exportName === undefined ? "" : `:${spec.exportName}`}`;
}

function isMissingModuleError(error: unknown, packageName: string): boolean {
	if (!isRecord(error) || error["code"] !== "MODULE_NOT_FOUND") return false;
	return error instanceof Error ? error.message.includes(packageName) : false;
}

function failure(code: ParseFailure["code"], message: string): ParseFailure {
	return { code, message };
}

function property(value: unknown, name: string): unknown {
	if (!isRecord(value)) return undefined;
	return value[name];
}

function isParseFailure(value: TreeSitterLanguage | ParseFailure): value is ParseFailure {
	return "code" in value && typeof value.code === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isTreeSitterLanguage(value: unknown): value is TreeSitterLanguage {
	if (!isRecord(value) || !isRecord(value.language)) return false;
	return Array.isArray(value.nodeTypeInfo);
}

function isParserConstructor(value: unknown): value is ParserConstructor {
	if (typeof value !== "function" || typeof value.prototype !== "object" || value.prototype === null) return false;
	return typeof value.prototype.parse === "function" && typeof value.prototype.setLanguage === "function";
}
