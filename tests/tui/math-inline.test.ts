import { describe, expect, it } from "vitest";
import { renderInlineMathText } from "../../src/tui/math-inline.js";

describe("math inline rendering", () => {
	it.each([
		["text", "\\text{行内公式}", "text", "行内公式"],
		["符号", "\\alpha + \\beta \\leq \\gamma", "text", "α + β ≤ γ"],
		["根号", "\\sqrt{x} + \\sqrt[3]{y}", "text", "√x + ∛y"],
		["上下标", "x_i^2 + a_{n+1}", "text", "xᵢ² + aₙ₊₁"],
		["分式与集合", "\\frac{1}{2}\\in\\mathbb{R}", "text", "1/2∈ℝ"],
		["未知命令", "\\unknown{x}", "text", "$\\unknown{x}$"],
		["源码模式", "\\text{行内公式}", "source", "$\\text{行内公式}$"],
	] as const)("转换 %s", (_name, source, mode, expected) => {
		expect(renderInlineMathText(source, mode)).toBe(expected);
	});
});
