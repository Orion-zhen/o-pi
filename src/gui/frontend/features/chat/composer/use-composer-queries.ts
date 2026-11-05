import { useCallback, useEffect, useState } from "react";
import type { GuiQueryResults, Query } from "../../../../shared/protocol/queries.ts";
import type { Send } from "@/connection/connection.ts";
import { LatestRequest, type Remote } from "@/connection/latest-request.ts";

export function useComposerQueries({ draft, connected, send, query }: {
	draft: string; connected: boolean; send: Send; query: Query;
}) {
	const [sync, setSync] = useState<Remote<void>>({ state: "loading" });
	const [completions, setCompletions] = useState<{ text: string; result: Remote<GuiQueryResults["complete"]> }>();
	const [files, setFiles] = useState<{ text: string; result: Remote<string[]> }>();
	const [fileRequest] = useState(() => new LatestRequest());
	useEffect(() => {
		const sync = new LatestRequest(), completion = new LatestRequest();
		const timer = setTimeout(() => {
			if (!connected) return;
			void sync.run(() => send({ action: "draft", text: draft }), setSync);
			if (/^\/\S+/.test(draft)) void completion.run(() => query({ query: "complete", text: draft }), (result) => setCompletions({ text: draft, result }));
		}, 250);
		return () => { sync.cancel(); completion.cancel(); clearTimeout(timer); };
	}, [draft, connected, send, query]);
	useEffect(() => {
		setFiles(undefined); setCompletions(undefined); setSync({ state: "loading" });
		return () => fileRequest.cancel();
	}, [connected, fileRequest]);
	const clearFiles = useCallback(() => { fileRequest.cancel(); setFiles(undefined); }, [fileRequest]);
	const completeFiles = (prefix: string) => fileRequest.run(() => query({ query: "files", prefix }), (result) => setFiles({ text: draft, result }));
	return {
		argumentChoices: completions?.text === draft && completions.result.state === "ready" ? completions.result.value : [],
		fileChoices: files?.text === draft && files.result.state === "ready" ? files.result.value : [],
		completeFiles, clearFiles,
		error: [sync, completions?.result, files?.result].flatMap((result) => result?.state === "error" ? [result.message] : []).join("\n"),
	};
}
