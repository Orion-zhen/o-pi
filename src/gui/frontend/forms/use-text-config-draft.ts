import type { SetStateAction } from "react";
import { useConfigDraft } from "./use-config-draft.ts";

const readDraft = (content: string) => ({ content, sourceEdited: false });

/** 源码编辑保留格式修改，标记随草稿加载、保存和放弃一起重置。 */
export function useTextConfigDraft<D extends { content: string }>(initial: D) {
	const editor = useConfigDraft(initial, readDraft);
	return {
		...editor,
		draft: editor.draft.content,
		sourceEdited: editor.draft.sourceEdited,
		change(update: SetStateAction<string>) {
			editor.change((draft) => ({ ...draft, content: typeof update === "function" ? update(draft.content) : update }));
		},
		changeSource(content: string) {
			editor.change({ content, sourceEdited: content !== editor.document.content });
		},
		async save(content: string, persist: (document: D, content: string) => Promise<D>) {
			await editor.save(content, persist);
			editor.change((draft) => ({ ...draft, sourceEdited: false }));
		},
	};
}
