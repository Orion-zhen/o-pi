import MagicString from "magic-string";
import type { Plugin } from "vite";

// 上游将所有语法表预打包进一个解析器模块，提取纯数据后才能按模块分块。
export function mermaidGrammarChunks(): Plugin {
	const prefix = "\0mermaid-grammar-";
	const grammars = new Map<string, string>();
	return {
		name: "mermaid-grammar-chunks",
		apply: "build",
		enforce: "pre",
		buildStart() { grammars.clear(); },
		resolveId(id) { if (grammars.has(id)) return id; },
		load(id) { return grammars.get(id); },
		transform(code, id) {
			if (!/[/\\]@mermaid-js[/\\]parser[/\\]dist[/\\].*\.mjs$/.test(id)) return;
			const output = new MagicString(code);
			const imports: string[] = [];
			// 只移动无插值模板，原样保留转义和语法表内容。
			for (const match of code.matchAll(/loadGrammarFromJson\(\s*(`(?:\\[\s\S]|[^`\\$]|\$(?!\{))*`)\s*\)/g)) {
				const literal = match[0].slice(match[0].indexOf("`"), match[0].lastIndexOf("`") + 1);
				const name = `mermaidGrammar${grammars.size}`;
				const moduleId = `${prefix}${grammars.size}.js`;
				// 函数边界防止打包器把字符串常量重新内联到解析器。
				grammars.set(moduleId, `export default () => ${literal};`);
				imports.push(`import ${name} from ${JSON.stringify(moduleId)};`);
				output.overwrite(match.index, match.index + match[0].length, `loadGrammarFromJson(${name}())`);
			}
			if (!imports.length) return;
			output.prepend(`${imports.join("\n")}\n`);
			return { code: output.toString(), map: output.generateMap({ hires: true, source: id, includeContent: true }) };
		},
	};
}
