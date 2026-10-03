import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { GuiQueryResults, Query } from "../../contract.ts";
import { ContentVisible } from "../components/ui/collapsible.tsx";
import { payloadKey } from "../../messages.ts";

export const GuiQueryContext = createContext<Query | undefined>(undefined);

function useGuiQuery(): Query {
	const query = useContext(GuiQueryContext);
	if (!query) throw new Error("缺少 GUI 查询上下文。");
	return query;
}

export function useToolOutput(id: string | undefined) {
	const query = useGuiQuery();
	const visible = useContext(ContentVisible);
	const [result, setResult] = useState<{ id: string; value: GuiQueryResults["toolOutput"] }>();
	const [error, setError] = useState("");
	useEffect(() => {
		if (!id || !visible) return;
		let cancelled = false;
		setError("");
		void query({ query: "toolOutput", id }).then(
			(value) => { if (!cancelled) setResult({ id, value }); },
			(error: unknown) => { if (!cancelled) setError(String(error)); },
		);
		return () => { cancelled = true; };
	}, [id, query, visible]);
	// 同一调用读取新进度时保留已有正文，避免加载占位符重挂详情并丢失展开状态。
	const value = result && id && (!visible || payloadKey(result.id) === payloadKey(id)) ? result.value : undefined;
	return { value, error };
}

export function SessionImage({ id, mime }: { id: string; mime: string }) {
	const query = useGuiQuery();
	const element = useRef<HTMLImageElement>(null);
	const [loaded, setLoaded] = useState<{ id: string; data: string }>();
	const [error, setError] = useState("");
	useEffect(() => {
		if (!element.current) return;
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
	const value = loaded?.id === id ? loaded.data : undefined;
	return <>{error && <span role="alert">{error}</span>}<img ref={element} className="attachment" src={value ? `data:${mime};base64,${value}` : undefined} alt="会话图片" loading="lazy" /></>;
}
