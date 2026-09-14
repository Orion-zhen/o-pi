import type { TreeSitterLanguage } from "../syntax-tree/grammars.ts";
import { bashExtractor } from "./adapters/bash.ts";
import { cExtractor } from "./adapters/c.ts";
import { cppExtractor } from "./adapters/cpp.ts";
import { goExtractor } from "./adapters/go.ts";
import { javascriptExtractor } from "./adapters/javascript.ts";
import { pythonExtractor } from "./adapters/python.ts";
import { rustExtractor } from "./adapters/rust.ts";
import type { LanguageExtractor } from "./adapters/types.ts";

/** 类型检查确保每个目录中的语言都有提取器。语法元数据只在共享目录维护。 */
export const LANGUAGE_EXTRACTORS: Record<TreeSitterLanguage, LanguageExtractor> = {
	javascript: javascriptExtractor,
	jsx: javascriptExtractor,
	typescript: javascriptExtractor,
	tsx: javascriptExtractor,
	python: pythonExtractor,
	go: goExtractor,
	rust: rustExtractor,
	c: cExtractor,
	cpp: cppExtractor,
	bash: bashExtractor,
};
