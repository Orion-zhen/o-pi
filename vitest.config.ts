import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		exclude: ["**/node_modules/**", "**/.git/**"],
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts", "agent/extensions/**/*.ts"],
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
