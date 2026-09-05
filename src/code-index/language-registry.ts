import type { TreeSitterLanguage } from "../syntax-tree/grammars.js";
import { bashExtractor } from "./adapters/bash.js";
import { cExtractor } from "./adapters/c.js";
import { cppExtractor } from "./adapters/cpp.js";
import { goExtractor } from "./adapters/go.js";
import { javascriptExtractor } from "./adapters/javascript.js";
import { pythonExtractor } from "./adapters/python.js";
import { rustExtractor } from "./adapters/rust.js";
import type { LanguageExtractor } from "./adapters/types.js";

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
