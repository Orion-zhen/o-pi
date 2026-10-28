import type { Many, none } from "stream-chain/defs.js";
import type { ParserOptions, Token } from "stream-json/core/parser.js";

// 3.7.0 导出了同步 tokenizer，但声明文件遗漏了这个具名导出。
declare module "stream-json/core/parser.js" {
	export function jsonParser(options?: ParserOptions): (chunk: string | typeof none) => Many<Token> | typeof none;
}
