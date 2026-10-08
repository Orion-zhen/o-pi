import { act, type ReactNode } from "react";
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
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		root = createRoot(document.body);
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		cleanup?.();
		vi.unstubAllGlobals();
	});
	return (node: ReactNode) => act(async () => root.render(node));
}
