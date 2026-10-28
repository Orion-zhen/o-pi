import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { MarkdownText } from "../../../../../src/gui/frontend/ui/content/markdown.tsx";
import { renderMermaid } from "../../../../../src/gui/frontend/ui/content/mermaid-renderer.ts";
import { validateMermaidSource } from "../../../../../src/gui/frontend/ui/content/mermaid-source.ts";
import { ImagePreviewProvider } from "../../../../../src/gui/frontend/ui/media/image-preview.tsx";
import { TooltipProvider } from "../../../../../src/gui/frontend/ui/tooltip.tsx";
import { deferred } from "../../../../helpers/async.ts";
import { useReactFixture } from "../../../helpers/react-fixture.ts";

vi.mock("../../../../../src/gui/frontend/ui/content/mermaid-renderer.ts", () => ({ renderMermaid: vi.fn() }));

const render = useReactFixture();
const engine = vi.mocked(renderMermaid);
const source = "flowchart LR\n开始 --> 结束";
const markdown = (text = source) => `\`\`\`mermaid\n${text}\n\`\`\``;
const url = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'/>";

function view(text: string, streaming = false) {
	return <TooltipProvider><ImagePreviewProvider sessionId="session" fallbackFocus={{ current: null }}>
		<MarkdownText text={text} streaming={streaming} />
	</ImagePreviewProvider></TooltipProvider>;
}

beforeEach(() => {
	engine.mockReset().mockResolvedValue(url);
	vi.stubGlobal("MutationObserver", window.MutationObserver);
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	vi.stubGlobal("getComputedStyle", () => ({ fontFamily: "system-ui", fontSize: "16px" }));
});

it("流式 Mermaid 保留源码，结束后渲染，普通代码块不受影响", async () => {
	const text = `${markdown()}\n\n\`\`\`text\n原样代码\n\`\`\``;
	await render(view(text, true));
	expect(engine).not.toHaveBeenCalled();
	expect(document.querySelector('[aria-label="Mermaid 源码"]')?.textContent).toBe(source);
	expect(document.querySelector('.mermaid-block [role="status"]')).toBeNull();
	expect(document.querySelector<HTMLButtonElement>('[aria-label="查看 Mermaid 图表"]')?.disabled).toBe(true);
	expect(document.querySelector('[aria-label="查看 Mermaid 源码"]')?.getAttribute("data-state")).toBe("on");
	await render(view(text));
	await vi.waitFor(() => expect(document.querySelector(".mermaid-picture img")?.getAttribute("src")).toBe(url));
	expect(document.querySelector('[aria-label="代码"]')?.textContent).toBe("原样代码");
	expect(engine).toHaveBeenCalledOnce();
});

it("切换源码和图表不重新渲染，两种视图都能复制源码", async () => {
	const writeText = vi.fn().mockResolvedValue(undefined);
	vi.stubGlobal("navigator", { clipboard: { writeText } });
	await render(view(markdown()));
	await vi.waitFor(() => expect(document.querySelector(".mermaid-picture img")).not.toBeNull());
	expect(document.querySelector(".mermaid-picture")?.getAttribute("aria-hidden")).toBe("false");
	expect(document.querySelector(".mermaid-picture")?.hasAttribute("inert")).toBe(false);
	await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="复制Mermaid"]')?.click());
	expect(writeText).toHaveBeenCalledWith(source + "\n");
	await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="查看 Mermaid 源码"]')?.click());

	expect(document.querySelector(".mermaid-picture")?.getAttribute("aria-hidden")).toBe("true");
	expect(document.querySelector(".mermaid-picture")?.hasAttribute("inert")).toBe(true);
	expect(document.querySelector('[aria-label="Mermaid 源码"]')?.textContent).toBe(source);
	writeText.mockClear();
	await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="复制Mermaid"]')?.click());
	expect(writeText).toHaveBeenCalledWith(source + "\n");
	await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="查看 Mermaid 图表"]')?.click());
	expect(document.querySelector(".mermaid-picture")?.getAttribute("aria-hidden")).toBe("false");
	expect(document.querySelector(".mermaid-picture")?.hasAttribute("inert")).toBe(false);
	expect(engine).toHaveBeenCalledOnce();
});

it("错误只影响当前图表，保留源码和相邻内容", async () => {
	engine.mockRejectedValueOnce(new Error("语法错误"));
	await render(view(`${markdown()}\n\n后续正文`));
	await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain("语法错误"));
	expect(document.querySelector('[aria-label="Mermaid 源码"]')?.textContent).toBe(source);
	expect(document.body.textContent).toContain("后续正文");
	expect(document.querySelector(".mermaid-picture img")).toBeNull();
});

it("切换主题后忽略过期结果，卸载取消尚未完成的渲染", async () => {
	const light = deferred<string>(), dark = deferred<string>(), pending = deferred<string>();
	engine.mockReturnValueOnce(light.promise).mockReturnValueOnce(dark.promise).mockReturnValueOnce(pending.promise);
	await render(view(markdown()));
	await vi.waitFor(() => expect(engine).toHaveBeenCalledOnce());
	expect(engine.mock.calls[0]?.[1].theme).toBe("redux");
	await act(async () => { document.documentElement.dataset.theme = "dark"; });
	await vi.waitFor(() => expect(engine).toHaveBeenCalledTimes(2));
	expect(engine.mock.calls[0]?.[2].aborted).toBe(true);
	expect(engine.mock.calls[1]?.[1].theme).toBe("redux-dark");
	await act(async () => dark.resolve(`${url}#dark`));
	await act(async () => light.resolve(url));
	expect(document.querySelector(".mermaid-picture img")?.getAttribute("src")).toBe(`${url}#dark`);
	await render(view(markdown(`${source}\n结束 --> 新节点`)));
	await vi.waitFor(() => expect(engine).toHaveBeenCalledTimes(3));
	await render(null);
	expect(engine.mock.calls[2]?.[2].aborted).toBe(true);
	await act(async () => pending.resolve(url));
});

it("根节点字体和字号变化后更新图表，其他样式变化不重新渲染", async () => {
	await render(view(markdown()));
	await vi.waitFor(() => expect(engine).toHaveBeenCalledOnce());
	// LinkeDOM 不通知已有 style 的 setProperty 变更，直接设置属性以触发观察器。
	await act(async () => { document.documentElement.setAttribute("style", "--material-transparency:0.5"); });
	expect(engine).toHaveBeenCalledOnce();
	vi.stubGlobal("getComputedStyle", () => ({ fontFamily: "serif", fontSize: "20px" }));
	await act(async () => {
		document.documentElement.setAttribute("style", "--material-transparency:0.5;--gui-font-ui:serif;--text-body:1.25rem");
	});
	await vi.waitFor(() => expect(engine).toHaveBeenCalledTimes(2));
	expect(engine.mock.calls[1]?.[1]).toEqual({ theme: "redux", fontFamily: "serif", fontSize: 20 });
});

it("允许源码主题和节点配色，拒绝超大源码", () => {
	expect(() => validateMermaidSource(`---\nconfig:\n  theme: forest\n---\n${source}\nclassDef warning fill:#ff0,color:#000`)).not.toThrow();
	expect(() => validateMermaidSource(`flowchart LR\n${"A".repeat(30_000)}`)).toThrow("30000");
});

it.each([
	'flowchart LR\nA@{ img: "https://example.com/a.png" }',
	'flowchart LR\nclassDef custom fill:url(https://example.com/a.svg)',
	String.raw`flowchart LR; classDef custom fill:u\72l(https://example.com/a.svg)`,
	'flowchart LR\nclassDef custom fill:u/**/rl(https://example.com/a.svg)',
	'flowchart LR\nclassDef custom background-image:image-set("https://example.com/a.png" 1x)',
])("拒绝渲染阶段的资源引用：%s", (text) => {
	expect(() => validateMermaidSource(text)).toThrow("外部资源");
});
