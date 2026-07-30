import { createRequire } from "node:module";
import type { Language as WebTreeSitterLanguage, Parser as WebTreeSitterParser } from "web-tree-sitter";

import type { GrammarSpec, ParseFailure } from "./types.js";

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

/** Runtime 和 grammar 按描述符共享；失败经过短暂退避后可重试。 */
export function loadTreeSitterRuntime(spec: GrammarSpec): Promise<TreeSitterRuntimeResult> {
	const key = descriptorKey(spec);
	return cachedResult(runtimes, key, () => createRuntime(spec));
}

/** 每种 grammar 缓存一个 parser；单次调用负责提供 deadline。 */
export function loadTreeSitterParser(spec: GrammarSpec): Promise<TreeSitterParserResult> {
	const key = descriptorKey(spec);
	return cachedResult(parsers, key, () => createParser(spec));
}

/** parser 异常后删除缓存和底层句柄。 */
export function invalidateTreeSitterParser(spec: GrammarSpec, parser: TreeSitterParser): void {
	const key = descriptorKey(spec);
	const cached = parsers.get(key);
	if (cached?.value !== undefined && "parser" in cached.value && cached.value.parser === parser) parsers.delete(key);
	safeDeleteParser(parser);
}

/** 仅用于进程或测试关闭；runtime 和 language 仍可复用。 */
export function disposeTreeSitterParserCache(): void {
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
	const grammarResult = await loadGrammarResult(spec, loadedModule.module);
	if ("failure" in grammarResult) return grammarResult;
	return { runtime: { Parser: loadedModule.module.Parser, language: grammarResult.language, grammar: spec } };
}

async function createParser(spec: GrammarSpec): Promise<TreeSitterParserResult> {
	const runtimeResult = await loadTreeSitterRuntime(spec);
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

function loadGrammarResult(spec: GrammarSpec, module: WebTreeSitterModule): Promise<GrammarResult> {
	const key = descriptorKey(spec);
	return cachedResult(grammars, key, () => loadGrammar(spec, module));
}

async function loadGrammar(spec: GrammarSpec, module: WebTreeSitterModule): Promise<GrammarResult> {
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
		// 缓存已移除，不再暴露失效句柄。
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
