import { useContext, useEffect, useState, type ReactNode } from "react";
import type { GlobalQuery, Query } from "../../../shared/protocol/queries.ts";
import { ContentVisible } from "@/ui/collapsible.tsx";
import { Feedback } from "@/ui/feedback.tsx";

export function SearchApiKeyControl({ config, query, children }: {
	config: string; query: Query<GlobalQuery>; children: ReactNode;
}) {
	const visible = useContext(ContentVisible);
	const [editing, setEditing] = useState(false);
	const [status, setStatus] = useState<{ config: string; available: boolean } | { config: string; error: string }>();
	useEffect(() => {
		if (!visible || editing) return;
		let active = true;
		void query({ query: "searchApiKeyAvailable", config }).then(
			(available) => { if (active) setStatus({ config, available }); },
			(error: unknown) => { if (active) setStatus({ config, error: String(error) }); },
		);
		return () => { active = false; };
	}, [config, query, visible, editing]);
	const result = status?.config === config ? status : undefined;
	return <div className="search-api-key-control" onFocusCapture={() => setEditing(true)}
		onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setEditing(false); }}>
		{children}
		<Feedback compact message={result ? "error" in result ? result.error : result.available ? "" : "不可用" : ""}
			tone={result && "error" in result ? "error" : "info"} />
	</div>;
}
