import { useCallback, useSyncExternalStore, type SetStateAction } from "react";
import type { Draft, SessionViews, SessionViewState } from "./session-views.ts";

export type { ImageAttachment } from "./session-views.ts";

/** 编辑器只订阅当前会话草稿，输入不触发整页重渲染。 */
export function useSessionDraft(record: SessionViewState, views: SessionViews) {
	const subscribe = useCallback((listener: () => void) => views.subscribe(record, listener), [record, views]);
	const read = useCallback(() => record.draft, [record]);
	const draft = useSyncExternalStore(subscribe, read, read);
	const update = useCallback(<K extends keyof Draft>(field: K, value: SetStateAction<Draft[K]>) => {
		views.update(record, (draft) => ({ ...draft, [field]: typeof value === "function" ? value(draft[field]) : value }));
	}, [record, views]);
	const setDraft = useCallback((value: SetStateAction<string>) => update("text", value), [update]);
	const setImages = useCallback((value: SetStateAction<Draft["images"]>) => update("images", value), [update]);
	const setBehavior = useCallback((value: SetStateAction<Draft["behavior"]>) => update("behavior", value), [update]);
	return { draft: draft.text, images: draft.images, behavior: draft.behavior, setDraft, setImages, setBehavior };
}
