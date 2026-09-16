import { useLayoutEffect, useRef, useState, type MouseEvent } from "react";

export function useTranscriptScroll(sessionId: string | undefined) {
	const scroll = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const follow = useRef(true);
	const [showLatest, setShowLatest] = useState(false);
	const toLatest = () => {
		follow.current = true;
		setShowLatest(false);
		if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
	};
	useLayoutEffect(() => {
		follow.current = true;
		if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
	}, [sessionId]);
	useLayoutEffect(() => {
		const viewport = scroll.current;
		const body = content.current;
		if (!viewport || !body) return;
		const observer = new ResizeObserver(() => {
			if (follow.current) viewport.scrollTop = viewport.scrollHeight;
			setShowLatest(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 60);
		});
		observer.observe(body);
		observer.observe(viewport);
		return () => observer.disconnect();
	}, []);
	return {
		scroll, content, showLatest, toLatest,
		toEntry: (id: string) => {
			const selector = CSS.escape(id);
			const target = content.current?.querySelector<HTMLElement>(`[data-entry-id="${selector}"]`) ??
				content.current?.querySelector<HTMLElement>(`[data-entry-ids~="${selector}"]`);
			if (!target) return;
			follow.current = false;
			let ancestor = target.parentElement;
			while (ancestor && ancestor !== content.current) {
				if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
				ancestor = ancestor.parentElement;
			}
			requestAnimationFrame(() => {
				const viewport = scroll.current;
				if (!viewport?.contains(target)) return;
				const bounds = target.getBoundingClientRect();
				const offset = bounds.top - viewport.getBoundingClientRect().top;
				viewport.scrollTop += offset - (viewport.clientHeight - Math.min(bounds.height, viewport.clientHeight)) / 2;
				target.tabIndex = -1;
				target.focus({ preventScroll: true });
			});
		},
		onScroll: () => {
			const viewport = scroll.current;
			if (!viewport) return;
			const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 60;
			follow.current = atBottom;
			setShowLatest(!atBottom);
		},
		onClickCapture: (event: MouseEvent<HTMLDivElement>) => {
			// 用户展开过程详情时保留阅读位置，不随下一段输出跳到底部。
			if (event.target instanceof Element && event.target.closest("summary, .activity-summary")) follow.current = false;
		},
	};
}
