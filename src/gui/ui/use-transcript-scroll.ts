import { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from "react";

export function useTranscriptScroll(sessionId: string | undefined) {
	const scroll = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const mode = useRef<"follow" | "paused" | "returning">("follow");
	const locationVersion = useRef(0);
	const positions = useRef(new Map<string, { top: number; follow: boolean }>());
	const restoring = useRef<number | undefined>(undefined);
	const lastScrollTop = useRef(0);
	const [showLatest, setShowLatest] = useState(false);
	const pinToBottom = () => {
		const viewport = scroll.current;
		if (!viewport) return;
		viewport.scrollTop = viewport.scrollHeight;
		lastScrollTop.current = viewport.scrollTop;
	};
	const cancelLocation = () => { locationVersion.current++; };
	const followLatest = () => {
		cancelLocation();
		mode.current = "follow";
		restoring.current = undefined;
		setShowLatest(false);
		pinToBottom();
	};
	const toLatest = () => {
		const viewport = scroll.current;
		if (!viewport || viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 1) {
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
		if (viewport) viewport.scrollTo({ top: viewport.scrollTop, behavior: "instant" });
	};
	useLayoutEffect(() => {
		const saved = sessionId ? positions.current.get(sessionId) : undefined;
		mode.current = saved?.follow === false ? "paused" : "follow";
		restoring.current = saved?.follow === false ? saved.top : undefined;
		if (restoring.current !== undefined && scroll.current) scroll.current.scrollTop = restoring.current;
		else pinToBottom();
		lastScrollTop.current = saved?.top ?? scroll.current?.scrollTop ?? 0;
		setShowLatest(saved?.follow === false);
		return () => {
			if (sessionId) positions.current.set(sessionId, { top: lastScrollTop.current, follow: mode.current === "follow" });
			cancelLocation();
		};
	}, [sessionId]);
	useLayoutEffect(() => {
		const viewport = scroll.current;
		const body = content.current;
		if (!viewport || !body) return;
		const observer = new ResizeObserver(() => {
			// 手动返回最新时，布局变化不能把平滑滚动改成瞬间置底。
			if (mode.current === "returning") return;
			if (restoring.current !== undefined) viewport.scrollTop = restoring.current;
			else if (mode.current === "follow") pinToBottom();
			setShowLatest(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 60);
		});
		const finishReturn = () => {
			if (mode.current !== "returning") return;
			if (viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 1) {
				viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
			} else followLatest();
		};
		observer.observe(body);
		observer.observe(viewport);
		viewport.addEventListener("scrollend", finishReturn);
		return () => {
			observer.disconnect();
			viewport.removeEventListener("scrollend", finishReturn);
		};
	}, [sessionId]);
	return {
		scroll, content, showLatest, toLatest, followLatest,
		restorePosition: () => {
			if (restoring.current !== undefined && scroll.current) {
				scroll.current.scrollTop = restoring.current;
				lastScrollTop.current = scroll.current.scrollTop;
				restoring.current = undefined;
			}
		},
		atLatest: () => Boolean(scroll.current && restoring.current === undefined && scroll.current.scrollHeight - scroll.current.scrollTop - scroll.current.clientHeight < 60),
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
			const target = content.current?.querySelector<HTMLElement>(`[data-entry-id="${selector}"]`) ??
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
					const viewport = scroll.current;
					if (version !== locationVersion.current || !viewport?.contains(target)) return;
					const bounds = target.getBoundingClientRect();
					const offset = bounds.top - viewport.getBoundingClientRect().top;
					viewport.scrollTo({ top: viewport.scrollTop + offset - (viewport.clientHeight - Math.min(bounds.height, viewport.clientHeight)) / 2, behavior: "smooth" });
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
			if (delta === 0 || (mode.current === "follow" && delta > 0)) return;
			const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 60;
			mode.current = atBottom ? "follow" : "paused";
			setShowLatest(!atBottom);
		},
		onClickCapture: (event: MouseEvent<HTMLDivElement>) => {
			cancelLocation();
			// 用户展开过程详情时保留阅读位置，不随下一段输出跳到底部。
			if (event.target instanceof Element && event.target.closest('[data-slot="collapsible-trigger"]')) mode.current = "paused";
		},
	};
}
