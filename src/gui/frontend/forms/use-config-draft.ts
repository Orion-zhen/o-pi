import { useState, type SetStateAction } from "react";

/** 编辑器只接收已加载文档，保存冲突由后端检查。 */
export function useConfigDraft<D extends { content: string }, T>(initial: D, readDraft: (content: string) => T) {
	const [document, setDocument] = useState(initial);
	const [draft, setDraft] = useState(() => readDraft(initial.content));
	return {
		document, draft,
		change(value: SetStateAction<T>) { setDraft(value); },
		discard() { setDraft(readDraft(document.content)); },
		async save(content: string, persist: (document: D, content: string) => Promise<D>) {
			setDocument(await persist(document, content));
		},
	};
}
