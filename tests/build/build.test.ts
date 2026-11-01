import { build } from "vite";
import { expect, it } from "vitest";
import { preserveEnv } from "../helpers/lifecycle.ts";

preserveEnv("NODE_ENV");

it("GUI 生产构建保留排错名称和映射，且不加载 IPC 校验器或未使用的字体", async () => {
	process.env.NODE_ENV = "production";
	const result = await build({
		configFile: "vite.gui.config.ts",
		logLevel: "silent",
		build: { write: false, reportCompressedSize: false },
	});
	if (!("output" in result)) throw new Error("预期单次 GUI 构建输出");
	const chunks = result.output.filter((item) => item.type === "chunk");
	expect(chunks.length).toBeGreaterThan(0);
	const welcome = chunks.filter((chunk) => chunk.fileName.startsWith("assets/welcome-art-"));
	expect(welcome).toHaveLength(1);
	for (const name of ["character", "reveal"]) {
		expect(welcome.some((chunk) => Object.keys(chunk.modules).some((id) => id.endsWith(`/assets/welcome/${name}.svg?welcome`)))).toBe(true);
	}
	expect(chunks.some((chunk) => Object.keys(chunk.modules).some((id) => id.includes("/node_modules/linkedom/")))).toBe(false);
	expect(chunks.some((chunk) => chunk.code.includes("ReplyBreathing"))).toBe(true);
	expect(chunks.some((chunk) => chunk.map?.sources.some((source) => source.endsWith("reply-breathing.tsx")))).toBe(true);
	expect(chunks.every((chunk) => !chunk.code.includes("//# sourceMappingURL="))).toBe(true);
	for (const chunk of chunks) {
		expect(Object.keys(chunk.modules).some((id) => id.includes("mathjax-newcm-font")), chunk.fileName).toBe(false);
		expect(Object.entries(chunk.modules).some(([id, module]) =>
			/\/src\/(?:gui\/shared\/protocol\/(?:actions|queries|connection|schema)|harness\/schema-validator)\.ts$/.test(id)
			&& module.renderedLength > 0), chunk.fileName).toBe(false);
	}
});
