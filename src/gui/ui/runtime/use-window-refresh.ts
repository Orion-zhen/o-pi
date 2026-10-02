import { useEffect, useRef } from "react";

/** 合并窗口焦点和页面可见性事件，不在后台轮询。 */
export function useWindowRefresh(connected: boolean, refresh: () => void) {
	const latest = useRef(refresh);
	latest.current = refresh;
	useEffect(() => {
		if (!connected) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const onFocus = () => {
			if (document.visibilityState !== "visible") return;
			clearTimeout(timer);
			timer = setTimeout(() => latest.current(), 150);
		};
		window.addEventListener("focus", onFocus);
		document.addEventListener("visibilitychange", onFocus);
		return () => {
			clearTimeout(timer);
			window.removeEventListener("focus", onFocus);
			document.removeEventListener("visibilitychange", onFocus);
		};
	}, [connected]);
}
