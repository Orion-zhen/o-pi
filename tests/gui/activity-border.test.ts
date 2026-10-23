import { act, createElement } from "react";
import { expect, it, vi } from "vitest";
import { ActivityBorder } from "../../src/gui/ui/components/activity-border.tsx";
import { useReactFixture } from "./react-fixture.ts";

vi.mock("motion/react", async (importOriginal) => ({
	...await importOriginal<typeof import("motion/react")>(),
	useInView: () => true,
}));

const renderRoot = useReactFixture();

it("运行边框在窗口失焦后继续播放，页面隐藏时暂停", async () => {
	let focused = true;
	document.hasFocus = () => focused;
	Object.defineProperty(document, "hidden", { configurable: true, value: false });
	await renderRoot(createElement(ActivityBorder, { state: "running" }));
	const border = document.querySelector(".activity-border");
	expect(border?.getAttribute("data-playing")).toBe("true");

	await act(async () => {
		focused = false;
		window.dispatchEvent(new window.Event("blur"));
	});
	expect(border?.getAttribute("data-playing")).toBe("true");

	await act(async () => {
		Object.defineProperty(document, "hidden", { value: true });
		document.dispatchEvent(new window.Event("visibilitychange"));
	});
	expect(border?.getAttribute("data-playing")).toBe("false");
});
