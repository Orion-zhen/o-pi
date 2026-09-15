import { defineConfig } from "vite";

export default defineConfig({
	root: "src/gui/ui",
	base: "./",
	build: { outDir: "../../../dist/gui", emptyOutDir: true },
});
