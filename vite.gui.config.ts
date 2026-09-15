import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
	root: "src/gui/ui",
	base: "./",
	plugins: [tailwindcss()],
	resolve: { alias: { "@": fileURLToPath(new URL("./src/gui/ui", import.meta.url)) } },
	build: { outDir: "../../../dist/gui", emptyOutDir: true },
});
