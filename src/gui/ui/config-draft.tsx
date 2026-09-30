import { useEffect, useState } from "react";

/** 编辑原文并保留打开时的版本，保存冲突仍交给后端检查。 */
export function useConfigDraft<D extends { content: string }>(load: () => Promise<D>) {
	const [document, setDocument] = useState<D>();
	const [draft, setDraft] = useState("");
	const [error, setError] = useState("");
	const [status, setStatus] = useState("");
	const [saving, setSaving] = useState(false);
	const [revision, setRevision] = useState(0);
	useEffect(() => {
		let active = true;
		setDocument(undefined);
		setError("");
		void load().then((value) => {
			if (active) { setDocument(value); setDraft(value.content); }
		}, (error: unknown) => { if (active) setError(String(error)); });
		return () => { active = false; };
	}, [load, revision]);
	return {
		document, draft, error, status, saving,
		dirty: document !== undefined && draft !== document.content,
		change(content: string) { setDraft(content); setStatus(""); },
		discard() { if (document) setDraft(document.content); setError(""); setStatus(""); },
		reload() { setStatus(""); setRevision((value) => value + 1); },
		async save(persist: (document: D, content: string) => Promise<D | undefined>, message = "已保存") {
			if (!document || saving) return;
			setSaving(true); setError(""); setStatus("");
			try {
				const saved = await persist(document, draft);
				if (saved) { setDocument(saved); setStatus(message); }
				else setError("保存失败，请查看错误通知。草稿已保留。");
			} finally { setSaving(false); }
		},
	};
}
