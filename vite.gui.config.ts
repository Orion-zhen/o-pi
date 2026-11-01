import { fileURLToPath } from "node:url";
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { applicationNames } from "./scripts/build/names.ts";
import { welcomeSvg } from "./scripts/welcome/plugin.ts";

export default defineConfig({
	root: "src/gui/frontend",
	base: "./",
	plugins: [tailwindcss(), welcomeSvg(), applicationNames(), {
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
		"@": fileURLToPath(new URL("./src/gui/frontend", import.meta.url)),
		// 与显式 fontData 保持一致，避免额外打包 NewCM 字体。
		"#default-font/svg/default.js": "@mathjax/mathjax-tex-font/js/svg/default.js",
	} },
	build: {
		outDir: "../../../dist/gui",
		sourcemap: "hidden",
		emptyOutDir: true,
		// 按功能加载分块，不为满足单块大小阈值拆分。
		chunkSizeWarningLimit: Infinity,
		rolldownOptions: {
			checks: { moduleLevelDirective: false },
			output: {
				codeSplitting: {
					groups: [
						{ name: "welcome-art", test: /assets[\\/]welcome[\\/].*\.svg\?welcome$/, includeDependenciesRecursively: false },
						{ name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
						{ name: "file-icons", test: /node_modules[\\/]@react-symbols[\\/]icons[\\/]/ },
						{ name: "ui", test: /node_modules[\\/](@radix-ui|@floating-ui)[\\/]/ },
						{ name: "motion", test: /node_modules[\\/](motion|motion-dom|motion-utils|framer-motion)[\\/]/ },
						{ name: "markdown", test: /node_modules[\\/](react-markdown|remark-gfm|react-syntax-highlighter|streamdown)[\\/]/ },
						// 解析器的转导出入口共享整套实现，合并为一个按需加载块。
						{ name: "mermaid-parser", test: /node_modules[\\/]@mermaid-js[\\/]parser[\\/]/ },
						// 只合并共享依赖，并按入口关系分组，避免提前加载其他图表。
						{
							name: "mermaid-shared",
							test: /node_modules[\\/](?:mermaid|d3-[^/\\]+|khroma)[\\/]/,
							minShareCount: 2,
							entriesAware: true,
							entriesAwareMergeThreshold: 20_000,
						},
					],
				},
			},
		},
	},
});
