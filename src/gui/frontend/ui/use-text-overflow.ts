import { useLayoutEffect, useState } from "react";

/** 按实际排版判断截断，保留完整文本，不用字符数猜测可见内容。 */
export function useTextOverflow(text: string, enabled = true) {
	const [element, ref] = useState<HTMLDivElement | null>(null);
	const [overflow, setOverflow] = useState(false);
	useLayoutEffect(() => {
		if (!element || !enabled) return;
		const measure = () => setOverflow(element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [element, text, enabled]);
	return { ref, overflow: enabled && overflow };
}
