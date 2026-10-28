import { useRef } from "react";
import { useInView, usePageInView } from "motion/react";

/** 元素在视口内且页面可见时返回 true，用于暂停循环装饰。 */
export function useAnimationVisibility<T extends Element>() {
	const ref = useRef<T>(null);
	const inView = useInView(ref);
	const pageInView = usePageInView();
	return { ref, playing: inView && pageInView };
}
