import { animate } from "motion/mini";
import { listDepth } from "@/ui/motion/transitions.ts";

export const startupListDuration = 600;
export const startupSidebarDuration = 400;

const rowSelector = ".history-session-row, .file-entry-row";

export function startupLists(sidebar: HTMLElement) {
	sidebar.dataset.startupLists = "";
	const active = new Map<HTMLElement, { animation: ReturnType<typeof animate>; transform: string; filter: string; visibility: string }>();
	let observer: MutationObserver | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let started = false;
	const stop = () => {
		observer?.disconnect();
		clearTimeout(timer);
		sidebar.removeAttribute("data-startup-lists");
		for (const [row, { animation, transform, filter, visibility }] of active) {
			animation.cancel();
			Object.assign(row.style, { transform, filter, visibility });
		}
		active.clear();
	};
	const start = (startsAt: number) => {
		if (started) return;
		started = true;
		const reveal = () => {
			for (const selector of [".history-scroll", ".workspace-files-scroll"]) {
				const viewport = sidebar.querySelector<HTMLElement>(selector);
				if (!viewport || !viewport.checkVisibility({ visibilityProperty: true })) continue;
				const bounds = viewport.getBoundingClientRect();
				const rows = [...viewport.querySelectorAll<HTMLElement>(rowSelector)].filter((row) => {
					const rect = row.getBoundingClientRect();
					return rect.height > 0 && rect.width > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom;
				});
				const duration = rows.length === 1 ? startupListDuration : listDepth.transition.duration * 1000;
				const interval = rows.length > 1 ? (startupListDuration - duration) / (rows.length - 1) : 0;
				rows.forEach((row, index) => {
					if (active.has(row)) return;
					const { transform, filter, visibility } = row.style;
					const animation = animate(row, {
						visibility: ["visible", "visible"],
						transform: [listDepth.hidden.transform, listDepth.visible.transform],
						filter: [listDepth.hidden.filter, listDepth.visible.filter],
					}, {
						duration: duration / 1000,
						delay: (startsAt + index * interval - performance.now()) / 1000,
						ease: listDepth.transition.ease,
					});
					active.set(row, { animation, transform, filter, visibility });
				});
			}
		};
		reveal();
		observer = new MutationObserver(reveal);
		observer.observe(sidebar, { childList: true, subtree: true });
		timer = setTimeout(stop, Math.max(0, startsAt + startupListDuration - performance.now()));
	};
	return { start, stop };
}
