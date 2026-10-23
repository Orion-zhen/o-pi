import { useEffect, useRef, useState } from "react";

type FileDropState = "idle" | "ready" | "over";

export function useFileDrop() {
	const ref = useRef<HTMLDivElement>(null);
	const [state, setState] = useState<FileDropState>("idle");

	useEffect(() => {
		let depth = 0;
		const reset = () => {
			depth = 0;
			setState("idle");
		};
		const track = (event: DragEvent) => {
			if (!event.dataTransfer?.types.includes("Files")) return;
			event.preventDefault();
			const over = event.target instanceof Node && ref.current?.contains(event.target);
			event.dataTransfer.dropEffect = over ? "copy" : "none";
			setState(over ? "over" : "ready");
		};
		const enter = (event: DragEvent) => {
			if (!event.dataTransfer?.types.includes("Files")) return;
			depth++;
			track(event);
		};
		const leave = () => {
			if (depth === 0) return;
			depth--;
			if (depth === 0) reset();
		};
		const drop = (event: DragEvent) => {
			// 阻止文件在输入框外松开时触发浏览器导航。
			if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
			reset();
		};
		document.addEventListener("dragenter", enter);
		document.addEventListener("dragover", track);
		document.addEventListener("dragleave", leave);
		document.addEventListener("drop", drop);
		document.addEventListener("dragend", reset);
		window.addEventListener("blur", reset);
		return () => {
			document.removeEventListener("dragenter", enter);
			document.removeEventListener("dragover", track);
			document.removeEventListener("dragleave", leave);
			document.removeEventListener("drop", drop);
			document.removeEventListener("dragend", reset);
			window.removeEventListener("blur", reset);
		};
	}, []);

	return { ref, state };
}
