import { createRequire } from "node:module";
import type ParserModule from "tree-sitter";

import { getLanguageAdapter } from "./language-registry.js";
import type { GrammarSpec } from "./adapters/types.js";
import type { CodeLanguage, SupportedCodeLanguage } from "./types.js";

type TreeSitterLanguage = ParserModule.Language;
type ParserConstructor = typeof ParserModule;

export interface TreeSitterRuntime {
	Parser: ParserConstructor;
	language: TreeSitterLanguage;
}

const require = createRequire(import.meta.url);
const runtimes = new Map<SupportedCodeLanguage, TreeSitterRuntime | undefined>();
const grammars = new Map<string, TreeSitterLanguage | undefined>();
let parserConstructor: ParserConstructor | undefined;

/** runtime 与 grammar 仅在首次解析对应语言时同步加载，并在进程内复用。 */
export function loadTreeSitterRuntime(language: CodeLanguage): TreeSitterRuntime | undefined {
	const adapter = getLanguageAdapter(language);
	if (adapter === undefined) return undefined;
	if (runtimes.has(adapter.language)) return runtimes.get(adapter.language);

	let runtime: TreeSitterRuntime | undefined;
	try {
		const Parser = parserConstructor ??= loadParserConstructor();
		const grammar = loadGrammar(adapter.grammar);
		if (grammar !== undefined) runtime = { Parser, language: grammar };
	} catch {
		runtime = undefined;
	}
	runtimes.set(adapter.language, runtime);
	return runtime;
}

/** 加载并校验一个 grammar descriptor；失败结果也会缓存，避免重复触发 native 加载。 */
export function loadGrammar(spec: GrammarSpec): TreeSitterLanguage | undefined {
	const key = `${spec.packageName}\0${spec.exportName ?? ""}`;
	if (grammars.has(key)) return grammars.get(key);

	let grammar: TreeSitterLanguage | undefined;
	try {
		const moduleValue: unknown = require(spec.packageName);
		const exported = spec.exportName === undefined ? moduleValue : property(moduleValue, spec.exportName);
		if (isTreeSitterLanguage(exported)) grammar = exported;
	} catch {
		grammar = undefined;
	}
	grammars.set(key, grammar);
	return grammar;
}

function loadParserConstructor(): ParserConstructor {
	const moduleValue: unknown = require("tree-sitter");
	if (!isParserConstructor(moduleValue)) throw new Error("Invalid tree-sitter runtime export");
	return moduleValue;
}

function property(value: unknown, name: string): unknown {
	if (!isRecord(value)) return undefined;
	return value[name];
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
