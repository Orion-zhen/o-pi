import { createRequire } from "node:module";
import type { Language as WebTreeSitterLanguage, Parser as WebTreeSitterParser } from "web-tree-sitter";

import type { GrammarSpec, LanguageAdapter } from "./adapters/types.js";
import type { ParseFailure } from "./types.js";

type WebTreeSitterModule = typeof import("web-tree-sitter");
type ParserConstructor = WebTreeSitterModule["Parser"];

export type TreeSitterParser = WebTreeSitterParser;

export interface TreeSitterRuntime {
	Parser: ParserConstructor;
	language: WebTreeSitterLanguage;
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
type ModuleResult = { module: WebTreeSitterModule } | { failure: ParseFailure };
type GrammarResult = { language: WebTreeSitterLanguage } | { failure: ParseFailure };
interface CachedResult<T extends object> {
	promise: Promise<T>;
	value?: T;
	failedAt?: number;
}

const TREE_SITTER_FAILURE_RETRY_MS = 1_000;

const runtimes = new Map<string, CachedResult<TreeSitterRuntimeResult>>();
const grammars = new Map<string, CachedResult<GrammarResult>>();
const parsers = new Map<string, CachedResult<TreeSitterParserResult>>();
const modules = new Map<string, CachedResult<ModuleResult>>();

/** Load a grammar/runtime descriptor without consulting the language registry. */
export function loadTreeSitterRuntimeForAdapter(adapter: Pick<LanguageAdapter, "grammar">): Promise<TreeSitterRuntimeResult> {
	return loadTreeSitterRuntimeForGrammar(adapter.grammar);
}

/** Runtime and grammar results are deduplicated; failures are retried after a short backoff. */
export function loadTreeSitterRuntimeForGrammar(spec: GrammarSpec): Promise<TreeSitterRuntimeResult> {
	const key = descriptorKey(spec);
	return cachedResult(runtimes, key, () => createRuntime(spec));
}

/** Cache one parser per grammar descriptor. Parse deadlines are supplied per call. */
export function loadTreeSitterParser(adapter: Pick<LanguageAdapter, "grammar">): Promise<TreeSitterParserResult> {
	const key = descriptorKey(adapter.grammar);
	return cachedResult(parsers, key, () => createParser(adapter));
}

/** Remove and release one parser after an unexpected parser-level exception. */
export function invalidateTreeSitterParser(
	adapter: Pick<LanguageAdapter, "grammar">,
	parser: TreeSitterParser,
): void {
	const key = descriptorKey(adapter.grammar);
	const cached = parsers.get(key);
	if (cached?.value !== undefined && "parser" in cached.value && cached.value.parser === parser) parsers.delete(key);
	safeDeleteParser(parser);
}

/** Release cached parser handles. Runtime and languages remain reusable. */
export function disposeTreeSitterParsers(): void {
	for (const entry of parsers.values()) {
		void entry.promise.then(
			(result) => {
				if ("parser" in result) safeDeleteParser(result.parser);
			},
			() => {},
		);
	}
	parsers.clear();
}

async function createRuntime(spec: GrammarSpec): Promise<TreeSitterRuntimeResult> {
	const loadedModule = await loadParserModule();
	if ("failure" in loadedModule) return loadedModule;
	const grammar = await loadGrammarResult(spec, loadedModule.module);
	if ("failure" in grammar) return grammar;
	return { runtime: { Parser: loadedModule.module.Parser, language: grammar.language, grammar: spec } };
}

async function createParser(adapter: Pick<LanguageAdapter, "grammar">): Promise<TreeSitterParserResult> {
	const runtimeResult = await loadTreeSitterRuntimeForAdapter(adapter);
	if ("failure" in runtimeResult) return runtimeResult;
	let parser: TreeSitterParser;
	try {
		parser = new runtimeResult.runtime.Parser();
	} catch {
		return { failure: failure("PARSER_INITIALIZATION_FAILED", "Tree-sitter parser could not be initialized.") };
	}
	try {
		parser.setLanguage(runtimeResult.runtime.language);
	} catch {
		parser.delete();
		return { failure: failure("GRAMMAR_INCOMPATIBLE", "Tree-sitter grammar is incompatible with the runtime.") };
	}
	return { parser };
}

function loadParserModule(): Promise<ModuleResult> {
	return cachedResult(modules, "runtime", initializeParserModule);
}

async function initializeParserModule(): Promise<ModuleResult> {
	try {
		const module = await import("web-tree-sitter");
		const runtimeWasm = require.resolve("web-tree-sitter/web-tree-sitter.wasm");
		await module.Parser.init({ locateFile: () => runtimeWasm });
		return { module };
	} catch {
		return { failure: failure("RUNTIME_UNAVAILABLE", "Tree-sitter runtime is unavailable.") };
	}
}

function loadGrammarResult(
	spec: GrammarSpec,
	module: WebTreeSitterModule,
): Promise<{ language: WebTreeSitterLanguage } | { failure: ParseFailure }> {
	const key = descriptorKey(spec);
	return cachedResult(grammars, key, () => loadGrammar(spec, module));
}

async function loadGrammar(
	spec: GrammarSpec,
	module: WebTreeSitterModule,
): Promise<{ language: WebTreeSitterLanguage } | { failure: ParseFailure }> {
	let wasmPath: string;
	try {
		wasmPath = require.resolve(`${spec.packageName}/${spec.wasmFile}`);
	} catch {
		return { failure: failure("GRAMMAR_UNAVAILABLE", `Tree-sitter grammar ${descriptorLabel(spec)} is unavailable.`) };
	}
	try {
		return { language: await module.Language.load(wasmPath) };
	} catch {
		return { failure: failure("GRAMMAR_INCOMPATIBLE", `Tree-sitter grammar ${descriptorLabel(spec)} is incompatible with the runtime.`) };
	}
}

function cachedResult<T extends object>(
	cache: Map<string, CachedResult<T>>,
	key: string,
	create: () => Promise<T>,
): Promise<T> {
	const cached = cache.get(key);
	if (cached !== undefined && (cached.failedAt === undefined || Date.now() - cached.failedAt < TREE_SITTER_FAILURE_RETRY_MS)) {
		return cached.promise;
	}
	const entry: CachedResult<T> = { promise: create() };
	cache.set(key, entry);
	void entry.promise.then(
		(result) => {
			entry.value = result;
			if ("failure" in result) entry.failedAt = Date.now();
		},
		() => {
			entry.failedAt = Date.now();
		},
	);
	return entry.promise;
}

function safeDeleteParser(parser: TreeSitterParser): void {
	try {
		parser.delete();
	} catch {
		// The cache entry has already been removed; no invalid handle remains reusable.
	}
}

function descriptorKey(spec: GrammarSpec): string {
	return `${spec.packageName}\0${spec.wasmFile}`;
}

function descriptorLabel(spec: GrammarSpec): string {
	return `${spec.packageName}/${spec.wasmFile}`;
}

function failure(code: ParseFailure["code"], message: string): ParseFailure {
	return { code, message };
}
