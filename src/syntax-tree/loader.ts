import { createRequire } from "node:module";
import type { Language as WebTreeSitterLanguage, Parser as WebTreeSitterParser } from "web-tree-sitter";

import type { GrammarSpec } from "./types.js";

type WebTreeSitterModule = typeof import("web-tree-sitter");
export type TreeSitterParser = WebTreeSitterParser;

type ParserPromise = Promise<TreeSitterParser | undefined>;
interface ParserOwner {
	readonly key: string;
	readonly promise: ParserPromise;
}

const require = createRequire(import.meta.url);
let modulePromise: Promise<WebTreeSitterModule | undefined> | undefined;
const languages = new Map<string, Promise<WebTreeSitterLanguage | undefined>>();
const parsers = new Map<string, ParserPromise>();
const parserOwners = new WeakMap<TreeSitterParser, ParserOwner>();

/** 共享 Tree-sitter runtime，并永久缓存 runtime 初始化结果。 */
function loadParserModule(): Promise<WebTreeSitterModule | undefined> {
	modulePromise ??= initializeParserModule();
	return modulePromise;
}

/** 按 grammar 描述符缓存语言 Promise，确定失败后不重试。 */
function loadTreeSitterLanguage(spec: GrammarSpec): Promise<WebTreeSitterLanguage | undefined> {
	const key = descriptorKey(spec);
	const cached = languages.get(key);
	if (cached !== undefined) return cached;
	const promise = createLanguage(spec);
	languages.set(key, promise);
	return promise;
}

/** 每种 grammar 缓存一个 parser Promise。解析异常通过 invalidateTreeSitterParser 替换 parser。 */
export function loadTreeSitterParser(spec: GrammarSpec): ParserPromise {
	const key = descriptorKey(spec);
	const cached = parsers.get(key);
	if (cached !== undefined) return cached;
	const promise = createParser(spec);
	parsers.set(key, promise);
	void promise.then((parser) => {
		if (parser !== undefined) parserOwners.set(parser, { key, promise });
	});
	return promise;
}

/** parser 异常后删除对应缓存并释放底层句柄。 */
export function invalidateTreeSitterParser(spec: GrammarSpec, parser: TreeSitterParser): void {
	const key = descriptorKey(spec);
	const owner = parserOwners.get(parser);
	if (owner?.key === key && parsers.get(key) === owner.promise) parsers.delete(key);
	parserOwners.delete(parser);
	safeDeleteParser(parser);
}

async function createParser(spec: GrammarSpec): ParserPromise {
	const language = await loadTreeSitterLanguage(spec);
	if (language === undefined) return undefined;
	const module = await loadParserModule();
	if (module === undefined) return undefined;

	let parser: TreeSitterParser;
	try {
		parser = new module.Parser();
	} catch {
		return undefined;
	}
	try {
		parser.setLanguage(language);
	} catch {
		safeDeleteParser(parser);
		return undefined;
	}
	return parser;
}

async function initializeParserModule(): Promise<WebTreeSitterModule | undefined> {
	try {
		const module = await import("web-tree-sitter");
		const runtimeWasm = require.resolve("web-tree-sitter/web-tree-sitter.wasm");
		await module.Parser.init({ locateFile: () => runtimeWasm });
		return module;
	} catch {
		return undefined;
	}
}

async function createLanguage(spec: GrammarSpec): Promise<WebTreeSitterLanguage | undefined> {
	const module = await loadParserModule();
	if (module === undefined) return undefined;

	let wasmPath: string;
	try {
		wasmPath = require.resolve(`${spec.packageName}/${spec.wasmFile}`);
	} catch {
		return undefined;
	}
	try {
		return await module.Language.load(wasmPath);
	} catch {
		return undefined;
	}
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
