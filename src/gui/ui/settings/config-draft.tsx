import { useEffect, useState } from "react";

/** 编辑原文并保留打开时的版本，保存冲突由后端检查。 */
export function useConfigDraft<D extends { content: string }>(load: () => Promise<D>) {
	const [document, setDocument] = useState<D>();
	const [draft, setDraft] = useState("");
	const [error, setError] = useState("");
	const [revision, setRevision] = useState(0);
	useEffect(() => {
		let active = true;
		setDocument(undefined); setError("");
		void load().then((value) => {
			if (active) { setDocument(value); setDraft(value.content); }
		}, (error: unknown) => { if (active) setError(String(error)); });
		return () => { active = false; };
	}, [load, revision]);
	return {
		document, draft, error,
		dirty: document !== undefined && draft !== document.content,
		change(content: string) { setDraft(content); setError(""); },
		discard() { if (document) setDraft(document.content); setError(""); },
		reload() { setRevision((value) => value + 1); },
		async save(persist: (document: D, content: string) => Promise<D | undefined>) {
			if (!document) return false;
			setError("");
			const saved = await persist(document, draft);
			if (saved) setDocument(saved);
			else setError("保存失败，草稿已保留。");
			return saved !== undefined;
		},
	};
}
