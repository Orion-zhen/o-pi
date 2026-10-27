import { feedback, listDepth } from "@/ui/motion/transitions.ts";

const sidebarDuration = 400;
const listDuration = 600;

export function startupSidebar(sidebar: HTMLElement, side: "left" | "right") {
	const sidebarEndsAt = performance.now() + sidebarDuration;
	const animations: Animation[] = [];
	const activeRows = new Set<Element>();
	const offset = getComputedStyle(sidebar).getPropertyValue("--startup-offset");
	for (const target of side === "left" ? sidebar.children : [sidebar]) {
		const animation = target.animate([
			{ transform: offset, opacity: 0, easing: `cubic-bezier(${feedback.ease.join(",")})` },
			{ opacity: 1, offset: 0.4 },
			{ transform: "none", opacity: 1 },
		], { duration: sidebarDuration, fill: "both" });
		animation.onfinish = () => animation.cancel();
		animations.push(animation);
	}
	if (side === "left") sidebar.dataset.startupLists = "";
	let observer: MutationObserver | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let started = false;
	const stop = () => {
		observer?.disconnect();
		clearTimeout(timer);
		sidebar.removeAttribute("data-startup-lists");
		for (const animation of animations) animation.cancel();
		animations.length = 0;
		activeRows.clear();
	};
	const ready = () => {
		if (side !== "left" || started) return;
		started = true;
		const startsAt = Math.max(performance.now(), sidebarEndsAt);
		const reveal = () => {
			for (const selector of [".history-scroll", ".workspace-files-scroll"]) {
				const viewport = sidebar.querySelector<HTMLElement>(selector);
				if (!viewport || !viewport.checkVisibility({ visibilityProperty: true })) continue;
				const bounds = viewport.getBoundingClientRect();
				const rows = [...viewport.querySelectorAll(".history-session-row, .file-entry-row")].filter((row) => {
					const rect = row.getBoundingClientRect();
					return rect.height > 0 && rect.width > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom;
				});
				const duration = rows.length === 1 ? listDuration : listDepth.transition.duration * 1000;
				const interval = rows.length > 1 ? (listDuration - duration) / (rows.length - 1) : 0;
				rows.forEach((row, index) => {
					if (activeRows.has(row)) return;
					activeRows.add(row);
					animations.push(row.animate([
						{ ...listDepth.hidden, visibility: "visible" },
						{ ...listDepth.visible, visibility: "visible" },
					], { duration, delay: startsAt + index * interval - performance.now(),
						easing: `cubic-bezier(${listDepth.transition.ease.join(",")})`, fill: "both" }));
				});
			}
		};
		reveal();
		observer = new MutationObserver(reveal);
		observer.observe(sidebar, { childList: true, subtree: true });
		timer = setTimeout(stop, startsAt + listDuration - performance.now());
	};
	return { ready, stop };
}
