import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderDisplayMathImage, warmMathRenderer } from "../../src/tui/math-renderer.js";
import type { TuiMathConfig } from "../../src/tui/types.js";

const mathConfig: TuiMathConfig = {
	enabled: true,
	max_width_cells: 120,
	max_height_cells: 18,
	svg_scale: 2,
	foreground: "#d4d4d4",
};

describe("math renderer 字体初始化", () => {
	it("字体加载失败时 reject 且图片 renderer 保持未就绪", async () => {
		vi.resetModules();
		const error = new Error("font unavailable");
		const { FontData } = await import("@mathjax/src/js/output/common/FontData.js");
		const loadFonts = vi.spyOn(FontData.prototype, "loadDynamicFiles").mockRejectedValue(error);
		try {
			const renderer = await import("../../src/tui/math-renderer.js");

			await expect(renderer.warmMathRenderer()).rejects.toBe(error);
			expect(renderer.renderDisplayMathImage(String.raw`x^2`, mathConfig)).toBeUndefined();
		} finally {
			loadFonts.mockRestore();
			vi.resetModules();
		}
	});
});

describe("math renderer", () => {
	beforeAll(warmMathRenderer);

	it.each([
		["mathbb 与 aligned", String.raw`\begin{aligned}
\mathbb{P}(A \cap B \mid C) &= \frac{\mathbb{P}(A \cap B \cap C)}{\mathbb{P}(C)} \\
&= \frac{\mathbb{P}(A \mid B \cap C) \, \mathbb{P}(B \cap C)}{\mathbb{P}(C)} \\
&= \mathbb{P}(A \mid B \cap C) \, \mathbb{P}(B \mid C)
\end{aligned}`],
		["字面量小于号", String.raw`P(r, \theta) =
\begin{cases}
\displaystyle
\frac{1}{\pi a^2} \sum _{m=-\infty}^{\infty} \sum _{n=1}^{\infty}
\frac{J_m(\lambda_{mn} r / a)}{J_{m+1}(\lambda_{mn})^2}
e^{i m \theta}, & 0 \le r < a, \\[12pt]
0, & r \ge a,
\end{cases}`],
		["cancel", String.raw`\begin{aligned}
\mathcal{L}_{SM} &= -\frac{1}{4}F^a_{\mu\nu}F^{a\mu\nu} + i\bar{\psi}\cancel{D}\psi + (D_\mu\Phi)^\dagger(D^\mu\Phi)-V(\Phi) \\
&+ \sum_f(-m_f\bar{\psi}_f\psi_f+\mathrm{h.c.}) + \frac{g_s}{2\sqrt{2}}\bar{q}\gamma^\mu T^aG^a_\mu q
\end{aligned}`],
		["boldsymbol", String.raw`\begin{aligned}
\mathcal{L}(\theta,\phi;\mathbf{x}) &= \mathbb{E}_{q_\phi(\mathbf{z}|\mathbf{x})}[\log p_\theta(\mathbf{x}|\mathbf{z})] - D_{KL}(q_\phi(\mathbf{z}|\mathbf{x}) \parallel p(\mathbf{z})) \\
q_\phi(\mathbf{z}|\mathbf{x}) &= \mathcal{N}(\mathbf{z}; \boldsymbol{\mu}, \boldsymbol{\sigma}^2\mathbf{I})
\end{aligned}`],
		["扩展包命令", String.raw`\begin{aligned}
\braket{\psi|\phi} \qquad
\qty(\frac{a}{b}) \qquad
\centernot{\implies} \qquad
\upmu\mathrm{m} \qquad
45\degree
\end{aligned}`],
	])("渲染%s公式", (_name, formula) => {
		const image = renderDisplayMathImage(formula, mathConfig);
		expect(image).toMatchObject({
			base64: expect.stringMatching(/.+/u),
			widthPx: expect.any(Number),
			heightPx: expect.any(Number),
		});
	});

	it("渲染 mathbb 不向终端输出 bboldx variant 警告", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const image = renderDisplayMathImage(String.raw`\mathbb{R}`, mathConfig);

			expect(image?.base64.length).toBeGreaterThan(0);
			expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("Invalid variant: -bboldx"));
		} finally {
			warn.mockRestore();
		}
	});
});
