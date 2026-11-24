import { useContext, useEffect, useState, type ComponentProps } from "react";
import type { GlobalQuery, Query } from "../../../shared/protocol/queries.ts";
import { ContentVisible } from "@/ui/collapsible.tsx";
import { Feedback } from "@/ui/feedback.tsx";

import { SettingsRow } from "@/forms/settings-controls.tsx";

export function SearchApiKeyRow({ config, query, children, ...row }: ComponentProps<typeof SettingsRow> & {
	config: string; query: Query<GlobalQuery>;
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
	return <SettingsRow {...row} layout="fluid" labelStatus={<Feedback compact message={result && "available" in result && !result.available ? "读取失败" : ""} />}>
		<div className="search-api-key-control" onFocusCapture={() => setEditing(true)}
			onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setEditing(false); }}>
			{children}
			<Feedback compact message={result && "error" in result ? result.error : ""} tone="error" />
		</div>
	</SettingsRow>;
}
