import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { GuiQueryResults, Query } from "../contract.ts";

export const GuiQueryContext = createContext<Query | undefined>(undefined);

export function useToolOutput(id: string | undefined) {
	const query = useContext(GuiQueryContext);
	const [result, setResult] = useState<{ id: string; value: GuiQueryResults["toolOutput"] }>();
	const [error, setError] = useState("");
	useEffect(() => {
		if (!id || !query) return;
		let cancelled = false;
		setError("");
		void query({ query: "toolOutput", id }).then(
			(value) => { if (!cancelled) setResult({ id, value }); },
			(error: unknown) => { if (!cancelled) setError(String(error)); },
		);
		return () => { cancelled = true; };
	}, [id, query]);
	return { value: result?.id === id ? result?.value : undefined, error };
}

export function SessionImage({ data, mime }: { data: string; mime: string }) {
	const query = useContext(GuiQueryContext);
	const element = useRef<HTMLImageElement>(null);
	const [loaded, setLoaded] = useState<{ id: string; data: string }>();
	const [error, setError] = useState("");
	const id = data.startsWith("opi-image:") ? data.slice("opi-image:".length) : undefined;
	useEffect(() => {
		if (!id || !query || !element.current) return;
		let cancelled = false;
		setError("");
		const observer = new IntersectionObserver((entries) => {
			if (!entries.some((entry) => entry.isIntersecting)) return;
			observer.disconnect();
			void query({ query: "image", id }).then(
				(data) => { if (!cancelled) setLoaded({ id, data }); },
				(error: unknown) => { if (!cancelled) setError(String(error)); },
			);
		});
		observer.observe(element.current);
		return () => { cancelled = true; observer.disconnect(); };
	}, [id, query]);
	const value = id ? loaded?.id === id ? loaded.data : undefined : data;
	return <>{error && <span role="alert">{error}</span>}<img ref={element} className="attachment" src={value ? `data:${mime};base64,${value}` : undefined} alt="会话图片" loading="lazy" /></>;
}
