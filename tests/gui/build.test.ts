import { build } from "vite";
import { expect, it } from "vitest";
import { preserveEnv } from "../helpers/lifecycle.ts";

preserveEnv("NODE_ENV");

it("GUI 生产构建的 JS 分块不超限，也不包含未使用的 MathJax 默认字体", async () => {
	process.env.NODE_ENV = "production";
	const result = await build({
		configFile: "vite.gui.config.ts",
		logLevel: "silent",
		build: { write: false, reportCompressedSize: false },
	});
	if (!("output" in result)) throw new Error("预期单次 GUI 构建输出");
	const chunks = result.output.filter((item) => item.type === "chunk");
	expect(chunks.length).toBeGreaterThan(0);
	for (const chunk of chunks) {
		expect(Buffer.byteLength(chunk.code), chunk.fileName).toBeLessThanOrEqual(500_000);
		expect(Object.keys(chunk.modules).some((id) => id.includes("mathjax-newcm-font")), chunk.fileName).toBe(false);
	}
});
