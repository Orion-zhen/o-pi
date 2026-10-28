import { useContext, useLayoutEffect, useRef } from "react";
import { useInView, useIsPresent, usePageInView } from "motion/react";
import { ContentVisible } from "@/ui/collapsible.tsx";

/** 折叠展开、在视口内且页面可见时才播放等待动画。 */
export function useReplyAnimation<T extends HTMLElement>(active: boolean) {
	const ref = useRef<T>(null);
	const expanded = useContext(ContentVisible);
	const present = useIsPresent();
	const inView = useInView(ref);
	const pageInView = usePageInView();
	const playing = active && expanded && present && inView && pageInView;
	useLayoutEffect(() => {
		for (const animation of ref.current?.getAnimations({ subtree: true }) ?? []) {
			if (!(animation instanceof CSSAnimation) || !animation.animationName.startsWith("reply-")) continue;
			if (playing) {
				animation.play();
				// 可见元素共用页面时钟，恢复时不逐帧更新祖先样式。
				animation.startTime = 0;
			} else animation.pause();
		}
	}, [playing]);
	return { ref, playing };
}
