import { useCallback, useEffect, useRef, useState } from "react";
import type { GuiQueryResults, Query } from "../contract.ts";
import type { Send } from "./connection.ts";

export function useComposerQueries({ draft, sessionId, connected, send, query, setError }: {
	draft: string; sessionId: string; connected: boolean; send: Send; query: Query; setError: (error: string) => void;
}) {
	const [completions, setCompletions] = useState<{ text: string; items: GuiQueryResults["complete"] }>();
	const [files, setFiles] = useState<{ text: string; paths: string[] }>();
	const fileVersion = useRef(0);
	useEffect(() => {
		let active = true;
		const timer = setTimeout(() => {
			if (!connected) return;
			void send({ action: "draft", text: draft });
			if (/^\/\S+/.test(draft)) void query({ query: "complete", text: draft }).then((items) => {
				if (active) setCompletions({ text: draft, items });
			}).catch((error: unknown) => {
				if (active) setError(error instanceof Error ? error.message : String(error));
			});
		}, 250);
		return () => { active = false; clearTimeout(timer); };
	}, [draft, sessionId, connected, send, query, setError]);
	useEffect(() => {
		setFiles(undefined);
		setCompletions(undefined);
		return () => { fileVersion.current++; };
	}, [sessionId, connected]);
	const clearFiles = useCallback(() => { fileVersion.current++; setFiles(undefined); }, []);
	const completeFiles = async (prefix: string) => {
		const version = ++fileVersion.current;
		try {
			const paths = await query({ query: "files", prefix });
			if (version === fileVersion.current) setFiles({ text: draft, paths });
		} catch (error) {
			if (version === fileVersion.current) setError(error instanceof Error ? error.message : String(error));
		}
	};
	return {
		argumentChoices: completions?.text === draft ? completions.items : [],
		fileChoices: files?.text === draft ? files.paths : [],
		completeFiles, clearFiles,
	};
}
