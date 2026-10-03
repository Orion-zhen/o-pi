import { useEffect } from "react";

/** 窗口不活跃时只暂停装饰动效，不影响会话执行或状态同步。 */
export function useActivityAnimations(): void {
	useEffect(() => {
		const root = document.documentElement;
		const update = () => { root.dataset.activityAnimations = String(!document.hidden && document.hasFocus()); };
		const pause = () => { root.dataset.activityAnimations = "false"; };
		update();
		window.addEventListener("focus", update);
		window.addEventListener("blur", pause);
		document.addEventListener("visibilitychange", update);
		return () => {
			window.removeEventListener("focus", update);
			window.removeEventListener("blur", pause);
			document.removeEventListener("visibilitychange", update);
			delete root.dataset.activityAnimations;
		};
	}, []);
}
