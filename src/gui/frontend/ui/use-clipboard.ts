import { useEffect, useState } from "react";

export function useClipboard() {
	const [state, setState] = useState<{ status: "idle" | "copied" | "error" }>({ status: "idle" });
	useEffect(() => {
		if (state.status !== "copied") return;
		const timer = setTimeout(() => setState({ status: "idle" }), 1500);
		return () => clearTimeout(timer);
	}, [state]);
	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			// 每次成功都更新对象，连续复制也会重新计时。
			setState({ status: "copied" });
		} catch {
			setState({ status: "error" });
		}
	}
	return { status: state.status, copy };
}
