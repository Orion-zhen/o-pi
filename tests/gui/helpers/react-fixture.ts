import { act, createElement, type ReactNode } from "react";
import { MotionConfig } from "motion/react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, vi } from "vitest";

/** 每个用例拥有独立 DOM，卸载完成后再恢复全局对象。 */
export function useReactFixture(cleanup?: () => void) {
	let root: Root;
	beforeEach(() => {
		const { window, document } = parseHTML("<html><body></body></html>");
		vi.stubGlobal("window", window);
		vi.stubGlobal("document", document);
		vi.stubGlobal("Element", window.Element);
		vi.stubGlobal("HTMLElement", window.HTMLElement);
		vi.stubGlobal("SVGElement", window.SVGElement);
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16));
		vi.stubGlobal("cancelAnimationFrame", clearTimeout);
		vi.stubGlobal("IntersectionObserver", class {
			observe() {}
			unobserve() {}
			disconnect() {}
			takeRecords() { return []; }
		});
		root = createRoot(document.body);
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		cleanup?.();
		vi.unstubAllGlobals();
	});
	return (node: ReactNode) => act(async () => root.render(createElement(MotionConfig, { isStatic: true }, node)));
}
