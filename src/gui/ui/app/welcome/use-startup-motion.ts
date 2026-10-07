import { useLayoutEffect, useRef, type RefObject } from "react";
import { startupLists, startupContentDuration, startupListDuration, startupSidebarDuration } from "./startup-lists.ts";
import "./startup-motion.css";

const regions = [
	{ name: "left", selector: ".sidebar" },
	{ name: "right", selector: ".session-sidebar" },
	{ name: "composer", selector: ".composer" },
	{ name: "welcome", selector: ".welcome" },
] as const;
type Region = typeof regions[number]["name"];

/** 入场按区域只播放一次，不等待异步数据，也不随会话组件重新挂载而重播。 */
export function useStartupMotion(root: RefObject<HTMLElement | null>, sessionReady: boolean) {
	const state = useRef<{
		seen: Set<Region>; active: Set<HTMLElement>; stopped: boolean; sidebarEndsAt: number;
		lists?: ReturnType<typeof startupLists>; refractionTimer?: ReturnType<typeof setTimeout>;
	}>({ seen: new Set(), active: new Set(), stopped: false, sidebarEndsAt: 0 });
	useLayoutEffect(() => {
		const element = root.current;
		if (!element) return;
		const startup = state.current;
		const finish = (target: HTMLElement) => {
			target.removeAttribute("data-startup");
			target.style.removeProperty("--startup-duration");
			target.style.removeProperty("--startup-delay");
			target.querySelector<SVGAnimateElement>(".welcome-refraction animate")?.endElement();
		};
		const stop = () => {
			startup.stopped = true;
			clearTimeout(startup.refractionTimer);
			startup.lists?.stop();
			for (const target of startup.active) finish(target);
			startup.active.clear();
		};
		const finished = (event: AnimationEvent) => {
			if ((event.animationName !== "startup-settle" && event.animationName !== "welcome-emerge") || !(event.target instanceof HTMLElement)) return;
			const target = event.target.closest<HTMLElement>("[data-startup]");
			if (target && startup.active.delete(target)) {
				if (target.dataset.startup === "welcome") startup.lists?.stop();
				finish(target);
			}
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
			if (region.name === "left" || region.name === "right") target.style.setProperty("--startup-duration", `${startupSidebarDuration}ms`);
			if (region.name === "left") {
				startup.sidebarEndsAt = performance.now() + startupSidebarDuration;
				startup.lists = startupLists(target);
			}
			if (region.name === "welcome") {
				const startsAt = Math.max(performance.now(), startup.sidebarEndsAt + startupListDuration - startupContentDuration);
				const delay = startsAt - performance.now();
				target.style.setProperty("--startup-duration", `${startupContentDuration}ms`);
				target.style.setProperty("--startup-delay", `${Math.max(0, delay)}ms`);
				startup.lists?.start(Math.max(performance.now(), startup.sidebarEndsAt));
				startup.refractionTimer = setTimeout(() => {
					const refraction = target.querySelector<SVGAnimateElement>(".welcome-refraction animate");
					if (refraction) {
						refraction.setAttribute("dur", `${startupContentDuration}ms`);
						refraction.beginElement();
					}
				}, Math.max(0, delay));
			}
			target.dataset.startup = region.name;
			startup.active.add(target);
		}
		if (sessionReady && !element.querySelector(".welcome")) startup.lists?.start(Math.max(performance.now(), startup.sidebarEndsAt));
	});
}
