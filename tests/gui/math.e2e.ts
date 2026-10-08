import { configureModel } from "./model-fixture.ts";
import { test, expect } from "./fixture.ts";
import { startModelServer } from "../cli/model-server.ts";

const formulas = [
	String.raw`E = mc^2`,
	String.raw`\frac{-b \pm \sqrt{b^2 - 4ac}}{2a}`,
	String.raw`\begin{pmatrix} \alpha & \beta \\ \gamma & \delta \end{pmatrix}`,
	String.raw`\mathbf{A} + \mathbb{R} + \mathfrak{g} + \mathcal{F}`,
	String.raw`\int_0^\infty e^{-x^2} \, dx = \frac{\sqrt{\pi}}{2}`,
	String.raw`\bra{\psi}\ket{\phi} + \cancel{x} + \pdv{f}{x}`,
];
let model: Awaited<ReturnType<typeof startModelServer>>;
test.beforeEach(async ({ workspace: { agentDir } }) => {
	model = await startModelServer(() => ({ text: formulas.map((tex, index) => index === 0 ? `$${tex}$` : `$$\n${tex}\n$$`).join("\n\n") }));
	await configureModel(agentDir, model.url, "math-test", { name: "test" });
});
test.afterEach(async () => { await model?.close(); });

test.describe("公式资源", () => {
	test("公式按需加载拆分后的引擎和字体，刷新后仍可渲染", async ({ gui: { page } }) => {
		const resources: string[] = [];
		page.on("request", (request) => { if (/\/math(?:jax|-formula)-/.test(request.url())) resources.push(request.url()); });
		await page.reload();
		const editor = page.getByRole("textbox", { name: "消息", exact: true });
		await expect(editor).toBeVisible();
		expect(resources).toEqual([]);
		await editor.fill("展示数学公式");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		for (let pass = 0; pass < 2; pass++) {
			for (const tex of formulas) {
				const formula = page.getByRole("math", { name: tex, exact: true });
				await expect(formula.locator("mjx-container")).toHaveCount(1);
				await expect(formula.locator("svg").first()).toBeVisible();
				await expect(formula.locator("path").first()).toBeAttached();
			}
			await expect(page.locator("[data-mjx-error], [data-mml-node='merror']")).toHaveCount(0);
			expect(resources.some((name) => name.includes("/mathjax-font-"))).toBe(true);
			if (pass === 0) { resources.length = 0; await page.reload(); }
		}
	});
});
