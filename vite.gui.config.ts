import { fileURLToPath } from "node:url";
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { mathjaxFontChunks } from "./scripts/build/mathjax.ts";

export default defineConfig({
	root: "src/gui/ui",
	base: "./",
	plugins: [tailwindcss(), mathjaxFontChunks(), {
		name: "pdf-reader-assets",
		async writeBundle(options) {
			if (!options.dir) throw new Error("缺少 GUI 输出目录。");
			const source = fileURLToPath(new URL("./node_modules/pdfjs-dist/", import.meta.url));
			const target = path.resolve(options.dir, "pdf");
			await mkdir(target, { recursive: true });
			await Promise.all([
				...["cmaps", "standard_fonts", "wasm"].map((name) => cp(path.join(source, name), path.join(target, name), { recursive: true })),
				cp(path.join(source, "build/pdf.worker.mjs"), path.join(target, "pdf.worker.mjs")),
			]);
		},
	}],
	resolve: { alias: {
		"@": fileURLToPath(new URL("./src/gui/ui", import.meta.url)),
		// 与显式 fontData 保持一致，避免额外打包 NewCM 字体。
		"#default-font/svg/default.js": "@mathjax/mathjax-tex-font/js/svg/default.js",
	} },
	build: {
		outDir: "../../../dist/gui",
		emptyOutDir: true,
		rolldownOptions: {
			checks: { moduleLevelDirective: false },
			output: {
				codeSplitting: {
					groups: [
						// 只拆纯字形数据，字体类和方向枚举留在引擎内，避免跨块初始化循环。
						{ name: "mathjax-font", test: /(?:node_modules[\\/]@mathjax[\\/]mathjax-tex-font[\\/]mjs[\\/]svg[\\/](?!default\.|delimiters\.)|\0mathjax-font-)/, maxSize: 450_000, includeDependenciesRecursively: false },
						{ name: "mathjax", test: /node_modules[\\/]@mathjax[\\/]/, includeDependenciesRecursively: false },
						{ name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
						{ name: "file-icons", test: /node_modules[\\/]@react-symbols[\\/]icons[\\/]/ },
						{ name: "ui", test: /node_modules[\\/](@radix-ui|@floating-ui)[\\/]/ },
						{ name: "motion", test: /node_modules[\\/](motion|motion-dom|motion-utils|framer-motion)[\\/]/ },
						{ name: "markdown", test: /node_modules[\\/](react-markdown|remark-gfm|react-syntax-highlighter)[\\/]/ },
					],
				},
			},
		},
	},
});
