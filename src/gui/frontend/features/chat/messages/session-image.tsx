import { useEffect, useRef, useState } from "react";
import { ImagePreviewButton } from "@/ui/media/image-preview.tsx";
import { useGuiQuery } from "@/connection/query-context.ts";

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
	const src = value ? `data:${mime};base64,${value}` : undefined;
	return <>{error && <span role="alert">{error}</span>}<ImagePreviewButton src={src} alt="会话图片">
		<img ref={element} className="attachment" src={src} alt="会话图片" loading="lazy" />
	</ImagePreviewButton></>;
}
