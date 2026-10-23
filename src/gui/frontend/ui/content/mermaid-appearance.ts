import { useLayoutEffect, useState, type RefObject } from "react";

export interface MermaidAppearance {
	theme: "redux" | "redux-dark";
	fontFamily: string;
	fontSize: number;
}

export function useMermaidAppearance(ref: RefObject<HTMLElement | null>): MermaidAppearance | undefined {
	const [appearance, setAppearance] = useState<MermaidAppearance>();
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		const root = document.documentElement;
		const media = matchMedia("(prefers-color-scheme: dark)");
		const update = () => {
			const style = getComputedStyle(element);
			const dark = root.dataset.theme === "dark" || (root.dataset.theme !== "light" && media.matches);
			const next: MermaidAppearance = { theme: dark ? "redux-dark" : "redux", fontFamily: style.fontFamily, fontSize: parseFloat(style.fontSize) };
			setAppearance((previous) => previous?.theme === next.theme && previous.fontFamily === next.fontFamily && previous.fontSize === next.fontSize ? previous : next);
		};
		update();
		const observer = new MutationObserver(update);
		observer.observe(root, { attributes: true, attributeFilter: ["data-theme", "style"] });
		media.addEventListener("change", update);
		return () => { observer.disconnect(); media.removeEventListener("change", update); };
	}, [ref]);
	return appearance;
}
