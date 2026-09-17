import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
	root: "src/gui/ui",
	base: "./",
	plugins: [tailwindcss()],
	resolve: { alias: { "@": fileURLToPath(new URL("./src/gui/ui", import.meta.url)) } },
	build: {
		outDir: "../../../dist/gui",
		emptyOutDir: true,
		rolldownOptions: {
			checks: { moduleLevelDirective: false },
			output: {
				codeSplitting: {
					groups: [
						{ name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
						{ name: "motion", test: /node_modules[\\/](motion|motion-dom|motion-utils|framer-motion)[\\/]/ },
						{ name: "markdown", test: /node_modules[\\/](react-markdown|remark-gfm|react-syntax-highlighter)[\\/]/ },
					],
				},
			},
		},
	},
});
