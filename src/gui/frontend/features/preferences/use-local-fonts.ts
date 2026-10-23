import { useEffect, useRef, useState } from "react";

interface LocalFontWindow extends Window {
	queryLocalFonts?: () => Promise<{ family: string }[]>;
}

export type LocalFonts = ReturnType<typeof useLocalFonts>;

export function useLocalFonts() {
	const [fonts, setFonts] = useState<string[]>();
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);
	const active = useRef(true);
	const pending = useRef(false);
	useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
	const localWindow: LocalFontWindow = window;
	const supported = typeof localWindow.queryLocalFonts === "function";
	const load = async () => {
		if (!localWindow.queryLocalFonts || pending.current) return;
		pending.current = true;
		setLoading(true);
		setError("");
		try {
			const available = await localWindow.queryLocalFonts();
			if (!active.current) return;
			setFonts([...new Set(available.map((font) => font.family))].sort((a, b) => a.localeCompare(b)));
			if (available.length === 0) setError("未获得本机字体列表，仍可手写字体名。");
		} catch (error) {
			if (active.current) setError(error instanceof DOMException && error.name === "NotAllowedError"
				? "未获字体访问权限，仍可手写字体名。"
				: "无法读取本机字体，请重试或手写字体名。");
		} finally {
			pending.current = false;
			if (active.current) setLoading(false);
		}
	};
	return { fonts, loading, supported, error, load };
}
