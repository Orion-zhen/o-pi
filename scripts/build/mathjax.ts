import { normal } from "@mathjax/mathjax-tex-font/js/svg/normal.js";
import type { Plugin } from "vite";

// normal 字形表单模块已超限，先拆成数据模块，再交给打包器分块。
export function mathjaxFontChunks(): Plugin {
	const prefix = "\0mathjax-font-";
	const chunks: string[] = [];
	let entries: string[] = [];
	let size = 0;
	for (const [key, value] of Object.entries(normal)) {
		const entry = `${JSON.stringify(key)}:${JSON.stringify(value)}`;
		if (size + entry.length > 200_000 && entries.length) {
			chunks.push(`export default {${entries.join(",")}};`);
			entries = [];
			size = 0;
		}
		entries.push(entry);
		size += entry.length;
	}
	chunks.push(`export default {${entries.join(",")}};`);
	return {
		name: "mathjax-font-chunks",
		resolveId(id) {
			if (id.startsWith(prefix)) return id;
		},
		load(id) {
			if (id.startsWith(prefix)) return chunks[Number(id.slice(prefix.length))];
			if (!/[/\\]@mathjax[/\\]mathjax-tex-font[/\\]mjs[/\\]svg[/\\]normal\.js$/.test(id)) return;
			return chunks.map((_, index) => `import part${index} from ${JSON.stringify(`${prefix}${index}`)};`).join("\n")
				+ `\nexport const normal = Object.assign({}, ${chunks.map((_, index) => `part${index}`).join(",")});`;
		},
	};
}
