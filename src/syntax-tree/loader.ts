import { createRequire } from "node:module";
import type { ParseOptions, Tree } from "web-tree-sitter";
import type { GrammarSpec } from "./types.js";

type ParseGrammar = (text: string, options: ParseOptions) => Tree | null;
const require = createRequire(import.meta.url);
let runtime: Promise<typeof import("web-tree-sitter")> | undefined;
const grammars = new Map<GrammarSpec, Promise<ParseGrammar>>();

/** 初始化失败也保留 Promise，不重复加载不可用的运行时或语法。 */
export function loadGrammar(spec: GrammarSpec): Promise<ParseGrammar> {
	let pending = grammars.get(spec);
	if (pending === undefined) {
		pending = initializeGrammar(spec);
		grammars.set(spec, pending);
	}
	return pending;
}

async function initializeRuntime() {
	const module = await import("web-tree-sitter");
	const wasm = require.resolve("web-tree-sitter/web-tree-sitter.wasm");
	await module.Parser.init({ locateFile: () => wasm });
	return module;
}

async function initializeGrammar(spec: GrammarSpec): Promise<ParseGrammar> {
	const module = await (runtime ??= initializeRuntime());
	const language = await module.Language.load(require.resolve(spec));
	return (text, options) => {
		// 每次解析独占解析器，返回的语法树独立存活，无需重置或失效共享句柄。
		const parser = new module.Parser();
		try {
			parser.setLanguage(language);
			return parser.parse(text, null, options);
		} finally {
			parser.delete();
		}
	};
}
