import { useLayoutEffect, useRef, type RefObject } from "react";
import "./startup-motion.css";

const regions = [
	{ name: "left", selector: ".sidebar", divider: ".sidebar-resize" },
	{ name: "right", selector: ".session-sidebar", divider: ".info-resize" },
	{ name: "composer", selector: ".composer", divider: null },
	{ name: "welcome", selector: ".welcome", divider: null },
] as const;
type Region = typeof regions[number]["name"];

/** 入场按区域只播放一次，不等待异步数据，也不随会话组件重新挂载而重播。 */
export function useStartupMotion(root: RefObject<HTMLElement | null>, sessionReady: boolean) {
	const state = useRef({ seen: new Set<Region>(), active: new Set<HTMLElement>(), stopped: false });
	useLayoutEffect(() => {
		const element = root.current;
		if (!element) return;
		const startup = state.current;
		const finish = (target: HTMLElement) => {
			target.removeAttribute("data-startup");
			target.querySelector<SVGAnimateElement>(".welcome-refraction animate")?.endElement();
		};
		const stop = () => {
			startup.stopped = true;
			for (const target of startup.active) finish(target);
			startup.active.clear();
		};
		const finished = (event: AnimationEvent) => {
			if ((event.animationName !== "startup-settle" && event.animationName !== "welcome-emerge") || !(event.target instanceof HTMLElement)) return;
			const target = event.target.closest<HTMLElement>("[data-startup]");
			if (target && startup.active.delete(target)) finish(target);
		};
		element.addEventListener("animationend", finished);
		window.addEventListener("pointerdown", stop, true);
		window.addEventListener("keydown", stop, true);
		window.addEventListener("wheel", stop, { capture: true, passive: true });
		window.addEventListener("resize", stop);
		return () => {
			stop();
			element.removeEventListener("animationend", finished);
			window.removeEventListener("pointerdown", stop, true);
			window.removeEventListener("keydown", stop, true);
			window.removeEventListener("wheel", stop, true);
			window.removeEventListener("resize", stop);
		};
	}, [root]);

	useLayoutEffect(() => {
		const element = root.current;
		const startup = state.current;
		if (!element || startup.stopped) return;
		for (const region of regions) {
			if (startup.seen.has(region.name)) continue;
			const target = element.querySelector<HTMLElement>(region.selector);
			if (!target) {
				// 恢复历史会话时不把欢迎页入场留给后续的新会话。
				if (region.name === "welcome" && sessionReady) startup.seen.add(region.name);
				continue;
			}
			startup.seen.add(region.name);
			if (target.getAttribute("data-open") === "false") continue;
			target.dataset.startup = region.name;
			startup.active.add(target);
			if (region.name === "welcome") target.querySelector<SVGAnimateElement>(".welcome-refraction animate")?.beginElement();
			const divider = region.divider ? element.querySelector<HTMLElement>(region.divider) : null;
			if (divider) {
				divider.dataset.startup = region.name;
				startup.active.add(divider);
			}
		}
	});
}
