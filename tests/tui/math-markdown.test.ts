import { Markdown, resetCapabilitiesCache, setCapabilities, setCellDimensions } from "@earendil-works/pi-tui";
import { getKittyImageMetadata } from "@earendil-works/pi-tui/dist/terminal-image.js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMathMarkdownRenderer, supportsDisplayMathImages, warmDisplayMathRenderer } from "../../src/tui/math-markdown.js";
import type { TuiMathConfig } from "../../src/tui/types.js";

const mathConfig: TuiMathConfig = {
	enabled: true,
	max_width_cells: 72,
	max_height_cells: 18,
	svg_scale: 2,
	foreground: "#d4d4d4",
};

const theme = {
	heading: (text: string) => text,
	link: (text: string) => text,
	linkUrl: (text: string) => text,
	code: (text: string) => text,
	codeBlock: (text: string) => text,
	codeBlockBorder: (text: string) => text,
	quote: (text: string) => text,
	quoteBorder: (text: string) => text,
	hr: (text: string) => text,
	listBullet: (text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	strikethrough: (text: string) => text,
	underline: (text: string) => text,
};

afterEach(() => {
	resetCapabilitiesCache();
	setCellDimensions({ widthPx: 9, heightPx: 18 });
});

describe("math markdown 字体初始化", () => {
	it("字体加载失败时继续使用 Pi 原生 LaTeX", async () => {
		vi.resetModules();
		const error = new Error("font unavailable");
		const { FontData } = await import("@mathjax/src/js/output/common/FontData.js");
		const loadFonts = vi.spyOn(FontData.prototype, "loadDynamicFiles").mockRejectedValue(error);
		const tui = await import("@earendil-works/pi-tui");
		try {
			const math = await import("../../src/tui/math-markdown.js");
			tui.setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
			tui.setCellDimensions({ widthPx: 9, heightPx: 18 });
			math.installMathMarkdownRenderer(mathConfig);

			await expect(math.warmDisplayMathRenderer()).rejects.toBe(error);
			const output = new tui.Markdown("$$\nx_i^2\n$$", 0, 0, theme).render(120).join("\n");
			expect(output).toContain("xᵢ²");
			expect(output).not.toContain("\u001b_G");
		} finally {
			tui.resetCapabilitiesCache();
			loadFonts.mockRestore();
			vi.resetModules();
		}
	});
});

describe("math markdown renderer", () => {
	beforeAll(async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		await warmDisplayMathRenderer();
	});

	it.each([
		["美元公式与 code span", "LLM 输出一个 $\\text{行内公式}$，不是 `$x$`。", ["LLM 输出一个 行内公式", "$x$"]],
		["价格", "This costs $5 and $10 tomorrow.", ["This costs $5 and $10 tomorrow."]],
		["环境变量", "Use $PATH and $HOME.", ["Use $PATH and $HOME."]],
		["原生括号分隔符", "Inline \\(not latex\\) and \\[x_i^2\\].", ["Inline not latex and xᵢ²."]],
		["数学特征", "Inline $x+1$ and \\(\\alpha + \\beta\\).", ["Inline x+1 and α + β."]],
	] as const)("行内内容交给 Pi 原生处理：%s", (_name, source, expected) => {
		const output = render(source);
		for (const text of expected) expect(output).toContain(text);
		expect(output).not.toContain("\u001b_G");
	});

	it.each([
		["美元", "before\n\n$$\n\\frac{x^2}{y}\n$$\n\nafter"],
		["方括号", "before\n\n\\[\n\\frac{x^2}{y}\n\\]\n\nafter"],
	])("无图片协议时%s块级公式交给 Pi 原生渲染", (_name, source) => {
		const output = render(source, null);
		expect(supportsDisplayMathImages()).toBe(false);
		expect(output).not.toContain("\u001b_G");
		for (const text of ["before", "x²", "─", "y", "after"]) expect(output).toContain(text);
		expect(output).not.toContain("\\frac");
	});

	it("图片增强关闭时仍保留 Pi 原生公式渲染", () => {
		const output = render("$$\nx_i^2\n$$", "kitty", { ...mathConfig, enabled: false });
		expect(output).toContain("xᵢ²");
		expect(output).not.toContain("\u001b_G");
	});

	it.each([
		["段落后的方括号", "**效果：**\n\\[\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n\\]", "\\begin{aligned}"],
		["行首裸环境", "**效果：**\n\\begin{align}\n\\dot{x} &= \\sigma (y - x) \\\\\n\\dot{y} &= x (\\rho - z) - y\n\\end{align}", "\\begin{align}"],
		["美元", "$$\nx_i^2\n$$", "x_i^2"],
		["方括号", "\\[\nx_i^2\n\\]", "x_i^2"],
	])("图片终端增强顶层%s块级公式", (_name, source, hiddenSource) => {
		const output = render(source);
		expect(output).toContain("\u001b_G");
		expect(output).not.toContain(hiddenSource);
	});

	it.each([
		["代码块", "```latex\n\\[\nx_i^2\n\\]\n\\begin{align}\na&=b\n\\end{align}\n```", "\\begin{align}"],
		["句内方括号公式", "普通文字里提到 \\[x_i^2\\]，只应由 Pi 原生文本化。", "xᵢ²"],
		["句内裸环境", "普通文字提到 \\begin{align}\na&=b\n\\end{align} 这个环境。", "\\begin{align}"],
		["引用中的公式", "> $$x_i^2$$", "xᵢ²"],
	])("不把%s提升为图片", (_name, source, expected) => {
		const output = render(source);
		expect(output).not.toContain("\u001b_G");
		expect(output).toContain(expected);
	});

	it("Pi 不支持的行内命令保留源码而不进入图片后端", () => {
		const output = render("Inline $\\braket{\\psi|\\phi}$ done");
		expect(output).toContain("$\\braket{\\psi|\\phi}$");
		expect(output).not.toContain("\u001b_G");
	});

	it("图片渲染失败时交回 Pi 原生回退", () => {
		const output = render("$$\n\\begin{unknown}x\\end{unknown}\n$$");
		expect(output).toContain("\\begin{unknown}x\\end{unknown}");
		expect(output).not.toContain("\u001b_G");
	});

	it.each([
		["kitty", "\u001b_G", "\u001b]1337;File="],
		["iterm2", "\u001b]1337;File=", "\u001b_G"],
	] as const)("%s 图片协议保留公式且不泄露源码", (images, sequence, excluded) => {
		const output = render("$$\nx_i^2\n$$", images);
		expect(supportsDisplayMathImages()).toBe(true);
		expect(output).toContain(sequence);
		expect(output).not.toContain(excluded);
		expect(output).not.toContain("x_i^2");
	});

	it("块级公式按自然尺寸显示，不放大到全局上限", () => {
		const lines = renderLines("$$\na^2 + b^2 = c^2\n$$");
		expect(lines.length).toBeLessThan(8);
		expect(lines.join("\n")).toContain("\u001b_G");
	});

	it("Kitty 公式注册全屏滚动所需的图片元数据", () => {
		const lines = renderLines("$$\n\\frac{x^2}{y}\n$$");
		const imageLine = lines.find((line) => line.includes("\u001b_G"));
		expect(imageLine).toBeDefined();
		const metadata = getKittyImageMetadata(imageLine ?? "");
		const size = parseKittySize(imageLine ?? "");

		expect(metadata).toMatchObject(size ?? {});
		expect(metadata?.widthPx).toBeGreaterThan(0);
		expect(metadata?.heightPx).toBeGreaterThan(0);
	});

	it("长公式使用可用宽度，复杂分式保留多行占位", () => {
		const config = { ...mathConfig, max_width_cells: 120 };
		const fourier = renderLines(
			"$$\nf(x) = a_0 + \\sum_{n=1}^{\\infty} \\left( a_n \\cos\\frac{n\\pi x}{L} + b_n \\sin\\frac{n\\pi x}{L} \\right) + \\sum_{n=1}^{\\infty} \\left( c_n \\cos\\frac{2n\\pi x}{L} + d_n \\sin\\frac{2n\\pi x}{L} \\right)\n$$",
			"kitty",
			config,
		);
		const bayes = renderLines("$$\nP(A \\mid B) = \\frac{P(B \\mid A) \\, P(A)}{P(B)}\n$$", "kitty", config);
		const fourierSize = parseKittySize(fourier.join("\n"));
		const bayesSize = parseKittySize(bayes.join("\n"));

		expect(fourierSize?.columns).toBeGreaterThan(72);
		expect(fourierSize?.columns).toBeLessThanOrEqual(120);
		expect(bayesSize?.rows).toBeGreaterThanOrEqual(4);
	});
});

function render(source: string, images: "kitty" | "iterm2" | null = "kitty", config = mathConfig): string {
	return renderLines(source, images, config).join("\n");
}

function renderLines(
	source: string,
	images: "kitty" | "iterm2" | null = "kitty",
	config = mathConfig,
): string[] {
	setCapabilities({ images, trueColor: true, hyperlinks: false });
	setCellDimensions({ widthPx: 9, heightPx: 18 });
	installMathMarkdownRenderer(config);
	return new Markdown(source, 0, 0, theme).render(120);
}

function parseKittySize(output: string): { columns: number; rows: number } | undefined {
	const params = output.match(/\u001b_G([^;]+);/)?.[1];
	if (params === undefined) return undefined;
	const values = new Map(params.split(",").map((part) => part.split("=", 2) as [string, string]));
	const columns = Number(values.get("c"));
	const rows = Number(values.get("r"));
	return Number.isFinite(columns) && Number.isFinite(rows) ? { columns, rows } : undefined;
}
