import { useCallback, useEffect, useRef, useState } from "react";

/** 确认状态只保留到失焦、点击外部或按 Esc。 */
export function useConfirmation() {
	const [armed, arm] = useState<string>();
	const button = useRef<HTMLButtonElement>(null);
	const cancel = useCallback(() => arm(undefined), []);
	useEffect(() => {
		if (armed === undefined) return;
		const outside = (event: PointerEvent) => {
			if (event.target instanceof Node && !button.current?.contains(event.target)) cancel();
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			cancel();
		};
		document.addEventListener("pointerdown", outside, true);
		// 先于弹窗的 document 捕获监听处理 Esc，只撤销本次确认。
		window.addEventListener("keydown", escape, true);
		return () => {
			document.removeEventListener("pointerdown", outside, true);
			window.removeEventListener("keydown", escape, true);
		};
	}, [armed, cancel]);
	return { armed, arm, button, cancel };
}
