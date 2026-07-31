import { Markdown, resetCapabilitiesCache, setCapabilities, setCellDimensions } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installMathMarkdownRenderer, supportsDisplayMathImages, warmDisplayMathRenderer } from "../../src/tui/math-markdown.js";
import type { TuiMathConfig } from "../../src/tui/types.js";

const mathConfig: TuiMathConfig = {
	enabled: true,
	display: true,
	inline: "text",
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

beforeAll(async () => {
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
	await warmDisplayMathRenderer();
});

afterEach(() => {
	resetCapabilitiesCache();
	setCellDimensions({ widthPx: 9, heightPx: 18 });
});

describe("math markdown renderer", () => {
	it.each([
		["美元公式与 code span", "LLM 输出一个 $\\text{行内公式}$，不是 `$x$`。", ["LLM 输出一个 行内公式", "$x$"]],
		["括号公式与 code span", "LLM 输出一个 \\(\\text{行内公式}\\)，不是 `\\(x\\)`。", ["LLM 输出一个 行内公式", "\\(x\\)"]],
		["价格", "This costs $5 and $10 tomorrow.", ["This costs $5 and $10 tomorrow."]],
		["环境变量", "Use $PATH and $HOME.", ["Use $PATH and $HOME."]],
		["普通括号", "Paren text \\(not latex\\) should stay text.", ["Paren text (not latex) should stay text."]],
		["数学特征", "Inline $x+1$ and \\(\\alpha + \\beta\\).", ["Inline x+1 and α + β."]],
	] as const)("正确区分行内公式与 %s", (_name, source, expected) => {
		const output = render(source);
		for (const text of expected) expect(output).toContain(text);
	});

	it.each([
		["美元", "before\n\n$$\nx_i^2\n$$\n\nafter"],
		["方括号", "before\n\n\\[\nx_i^2\n\\]\n\nafter"],
	])("终端不支持图片时%s块级公式回退为源码", (_name, source) => {
		const output = render(source, null);
		expect(supportsDisplayMathImages()).toBe(false);
		for (const text of ["before", "$$", "x_i^2", "after"]) expect(output).toContain(text);
	});

	it.each([
		["段落后的方括号", "**效果：**\n\\[\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n\\]", "\\begin{aligned}"],
		["行首裸环境", "**效果：**\n\\begin{align}\n\\dot{x} &= \\sigma (y - x) \\\\\n\\dot{y} &= x (\\rho - z) - y\n\\end{align}", "\\begin{align}"],
		["美元", "$$\nx_i^2\n$$", "x_i^2"],
		["方括号", "\\[\nx_i^2\n\\]", "x_i^2"],
	])("终端支持图片时渲染%s块级公式", (_name, source, hiddenSource) => {
		const output = render(source);
		expect(output).toContain("\u001b_G");
		expect(output).not.toContain(hiddenSource);
	});

	it.each([
		["代码块", "```latex\n\\[\nx_i^2\n\\]\n\\begin{align}\na&=b\n\\end{align}\n```", "\\begin{align}"],
		["普通方括号文本", "普通文字里提到 \\[x_i^2\\] 不应该变成块级图片。", "[x_i^2]"],
		["普通环境文本", "普通文字提到 \\begin{align}\na&=b\n\\end{align} 这个环境。", "\\begin{align}"],
	])("不渲染%s", (_name, source, expected) => {
		const output = render(source);
		expect(output).not.toContain("\u001b_G");
		expect(output).toContain(expected);
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
