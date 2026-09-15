import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: { alias: { "@": fileURLToPath(new URL("./src/gui/ui", import.meta.url)) } },
	test: {
		testTimeout: 15_000,
		setupFiles: ["./tests/helpers/worker-setup.ts"],
		exclude: ["**/node_modules/**", "**/.git/**", "o-pet/**"],
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			reporter: ["text", "json-summary"],
			thresholds: {
				statements: 80,
				branches: 68,
				functions: 85,
				lines: 85,
			},
		},
	},
});
