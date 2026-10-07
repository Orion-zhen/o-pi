import { useContext, useEffect, useState, type ReactNode } from "react";
import type { GlobalQuery, Query } from "../../contract.ts";
import { ContentVisible } from "../components/ui/collapsible";

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
	return <div className="search-api-key-control" onFocusCapture={() => setEditing(true)}
		onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setEditing(false); }}>
		{children}
		{status?.config === config && ("error" in status
			? <span role="alert">{status.error}</span>
			: !status.available && <span role="status">不可用</span>)}
	</div>;
}
