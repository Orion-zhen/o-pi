import { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from "react";

import type { SessionViewState } from "../sessions/session-views.ts";

export function useTranscriptScroll(sessionId: string | undefined, view: SessionViewState | undefined) {
	const scroll = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const mode = useRef<"follow" | "paused" | "returning">("follow");
	const locationVersion = useRef(0);
	const restoring = useRef<number | undefined>(undefined);
	const lastScrollTop = useRef(0);
	const [showLatest, setShowLatest] = useState(false);
	const atEnd = (threshold = 60) => Boolean(scroll.current &&
		scroll.current.scrollHeight - scroll.current.clientHeight - scroll.current.scrollTop <= threshold);
	const jumpTo = (top: number) => {
		scroll.current?.scrollTo({ top, behavior: "instant" });
		lastScrollTop.current = scroll.current?.scrollTop ?? 0;
	};
	const pinToBottom = () => { if (scroll.current) jumpTo(scroll.current.scrollHeight); };
	const cancelLocation = () => { locationVersion.current++; };
	const centerTarget = (target: HTMLElement) => {
		const viewport = scroll.current;
		if (!viewport?.contains(target)) return;
		const bounds = target.getBoundingClientRect();
		const top = viewport.scrollTop + bounds.top - viewport.getBoundingClientRect().top
			- (viewport.clientHeight - Math.min(bounds.height, viewport.clientHeight)) / 2;
		viewport.scrollTo({ top, behavior: "smooth" });
	};
	const followLatest = () => {
		cancelLocation();
		mode.current = "follow";
		restoring.current = undefined;
		setShowLatest(false);
		pinToBottom();
	};
	const toLatest = () => {
		const viewport = scroll.current;
		if (!viewport || atEnd(1)) {
			followLatest();
			return;
		}
		cancelLocation();
		mode.current = "returning";
		viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
	};
	const interrupt = () => {
		cancelLocation();
		if (mode.current !== "returning") return;
		mode.current = "paused";
		const viewport = scroll.current;
		viewport?.scrollTo({ top: viewport.scrollTop, behavior: "instant" });
	};
	useLayoutEffect(() => {
		const saved = view?.position;
		mode.current = saved?.follow === false ? "paused" : "follow";
		restoring.current = saved?.follow === false ? saved.top : undefined;
		if (restoring.current !== undefined) jumpTo(restoring.current);
		else pinToBottom();
		lastScrollTop.current = saved?.top ?? scroll.current?.scrollTop ?? 0;
		setShowLatest(saved?.follow === false);
		return () => {
			if (sessionId && view) view.position = { top: lastScrollTop.current, follow: mode.current === "follow" };
			cancelLocation();
		};
	}, [sessionId, view]);
	useLayoutEffect(() => {
		const viewport = scroll.current;
		const body = content.current;
		if (!viewport || !body) return;
		const observer = new ResizeObserver(() => {
			if (mode.current === "returning") return;
			if (restoring.current !== undefined) jumpTo(restoring.current);
			else if (mode.current === "follow") pinToBottom();
			setShowLatest(mode.current !== "follow" && !atEnd());
		});
		const finishReturn = () => {
			if (mode.current !== "returning") return;
			if (atEnd(1)) {
				mode.current = "follow";
				setShowLatest(false);
			} else viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
		};
		observer.observe(body);
		observer.observe(viewport);
		viewport.addEventListener("scrollend", finishReturn);
		return () => {
			observer.disconnect();
			viewport.removeEventListener("scrollend", finishReturn);
		};
	}, [sessionId, view]);
	return {
		scroll, content, showLatest, toLatest, followLatest,
		readFromStart: () => {
			cancelLocation();
			mode.current = "paused";
			restoring.current = undefined;
			jumpTo(0);
		},
		restorePosition: () => {
			if (restoring.current !== undefined && scroll.current) {
				jumpTo(restoring.current);
				restoring.current = undefined;
			}
		},
		atLatest: () => restoring.current === undefined && atEnd(),
		onWheel: (event: WheelEvent<HTMLDivElement>) => {
			interrupt();
			if (event.deltaY < 0) {
				mode.current = "paused";
				if (scroll.current) lastScrollTop.current = scroll.current.scrollTop;
			}
		},
		onTouchStart: interrupt,
		onPointerDown: interrupt,
		onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
			if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) interrupt();
		},
		toEntry: (id: string) => {
			const selector = CSS.escape(id);
			const target = content.current?.querySelector<HTMLElement>(`.reply-answer [data-entry-id="${selector}"]`) ??
				content.current?.querySelector<HTMLElement>(`.reply-body [data-entry-id="${selector}"]`) ??
				content.current?.querySelector<HTMLElement>(`[data-entry-id="${selector}"]`) ??
				content.current?.querySelector<HTMLElement>(`[data-entry-ids~="${selector}"]`);
			if (!target) return;
			interrupt();
			mode.current = "paused";
			const expanding: Element[] = [];
			let ancestor = target.parentElement;
			while (ancestor && ancestor !== content.current) {
				if (ancestor.matches('[data-slot="collapsible"][data-state="closed"]')) {
					ancestor.querySelector<HTMLButtonElement>(':scope > [data-slot="collapsible-trigger"]')?.click();
					const body = ancestor.querySelector(':scope > [data-slot="collapsible-content"] > .collapse-content');
					if (body) expanding.push(body);
				}
				ancestor = ancestor.parentElement;
			}
			const version = ++locationVersion.current;
			requestAnimationFrame(() => {
				// 展开后的尺寸稳定再定位，反向操作取消的过渡也视为结束。
				void Promise.allSettled(expanding.flatMap((body) => body.getAnimations().map((animation) => animation.finished))).then(() => {
					if (version !== locationVersion.current || !scroll.current?.contains(target)) return;
					centerTarget(target);
					target.tabIndex = -1;
					target.focus({ preventScroll: true });
				});
			});
		},
		onScroll: () => {
			const viewport = scroll.current;
			if (!viewport || mode.current === "returning" || restoring.current !== undefined) return;
			const delta = viewport.scrollTop - lastScrollTop.current;
			lastScrollTop.current = viewport.scrollTop;
			if (mode.current === "follow" && delta >= 0) return;
			const atBottom = atEnd();
			if (mode.current !== "paused" || delta > 0) mode.current = atBottom ? "follow" : "paused";
			setShowLatest(!atBottom);
		},
		onClickCapture: (event: MouseEvent<HTMLDivElement>) => {
			cancelLocation();
			// 用户展开过程详情时保留阅读位置，不随下一段输出跳到底部。
			if (event.target instanceof Element && event.target.closest('[data-slot="collapsible-trigger"]')) mode.current = "paused";
		},
	};
}
