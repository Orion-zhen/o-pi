import { useEffect, useState } from "react";

/** 保留打开时的版本，草稿表示由调用方决定，保存冲突由后端检查。 */
export function useConfigDraft<D extends { content: string }, T>(load: () => Promise<D>, readDraft: (content: string) => T) {
	const [document, setDocument] = useState<D>();
	const [draft, setDraft] = useState(() => readDraft(""));
	const [error, setError] = useState("");
	const [revision, setRevision] = useState(0);
	useEffect(() => {
		let active = true;
		setDocument(undefined); setError("");
		void load().then((value) => {
			if (active) { setDocument(value); setDraft(readDraft(value.content)); }
		}, (error: unknown) => { if (active) setError(String(error)); });
		return () => { active = false; };
	}, [load, readDraft, revision]);
	return {
		document, draft, error,
		change(value: T) { setDraft(value); setError(""); },
		discard() { if (document) setDraft(readDraft(document.content)); setError(""); },
		reload() { setRevision((value) => value + 1); },
		async save(content: string, persist: (document: D, content: string) => Promise<D | undefined>) {
			if (!document) return false;
			setError("");
			const saved = await persist(document, content);
			if (saved) setDocument(saved);
			else setError("保存失败，草稿已保留。");
			return saved !== undefined;
		},
	};
}
