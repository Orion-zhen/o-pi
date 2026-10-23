import { useContext, useEffect, useState } from "react";
import type { GuiQueryResults } from "../../../../shared/protocol/queries.ts";
import { ContentVisible } from "@/ui/collapsible.tsx";
import { payloadKey } from "../../../../shared/messages/output.ts";
import { useGuiQuery } from "@/connection/query-context.ts";

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
