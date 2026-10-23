import { build } from "vite";
import { expect, it } from "vitest";
import { preserveEnv } from "../helpers/lifecycle.ts";

preserveEnv("NODE_ENV");

it("GUI 生产构建保留排错名称和映射，仅 ELK 单体允许超限，且不加载 IPC 校验器或未使用的字体", async () => {
	process.env.NODE_ENV = "production";
	const result = await build({
		configFile: "vite.gui.config.ts",
		logLevel: "silent",
		build: { write: false, reportCompressedSize: false },
	});
	if (!("output" in result)) throw new Error("预期单次 GUI 构建输出");
	const chunks = result.output.filter((item) => item.type === "chunk");
	expect(chunks.length).toBeGreaterThan(0);
	expect(chunks.some((chunk) => chunk.code.includes("ReplyBreathing"))).toBe(true);
	expect(chunks.some((chunk) => chunk.map?.sources.some((source) => source.endsWith("reply-breathing.tsx")))).toBe(true);
	expect(chunks.every((chunk) => !chunk.code.includes("//# sourceMappingURL="))).toBe(true);
	const elk = chunks.filter((chunk) => chunk.fileName.startsWith("assets/mermaid-elk-"));
	expect(elk).toHaveLength(1);
	for (const chunk of chunks) {
		const isElk = elk.includes(chunk);
		// ELK 的上游单体不能按模块拆分，只给这一块设置独立预算。
		expect(Buffer.byteLength(chunk.code), chunk.fileName).toBeLessThanOrEqual(isElk ? 1_450_000 : 500_000);
		if (isElk) expect(Object.keys(chunk.modules).every((id) => /[/\\]elkjs[/\\]/.test(id))).toBe(true);
		expect(Object.keys(chunk.modules).some((id) => id.includes("mathjax-newcm-font")), chunk.fileName).toBe(false);
		expect(Object.entries(chunk.modules).some(([id, module]) =>
			/\/src\/(?:gui\/shared\/protocol\/(?:actions|queries|connection|schema)|harness\/schema-validator)\.ts$/.test(id)
			&& module.renderedLength > 0), chunk.fileName).toBe(false);
	}
});
