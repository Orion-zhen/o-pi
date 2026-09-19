import { useCallback, useState, type SetStateAction } from "react";
import type { Draft, SessionViews, SessionViewState } from "./session-views.ts";

export type { ImageAttachment } from "./session-views.ts";
const empty: Draft = { text: "", images: [], behavior: "steer" };

export function useSessionDraft(record: SessionViewState | undefined, views: SessionViews) {
	const [, render] = useState(0);
	const updateFor = useCallback(<K extends keyof Draft>(record: SessionViewState | undefined, field: K, value: SetStateAction<Draft[K]>) => {
		if (!record) return;
		if (views.update(record, (draft) => ({ ...draft, [field]: typeof value === "function" ? value(draft[field]) : value })))
			render((revision) => revision + 1);
	}, [views]);
	const update = useCallback(<K extends keyof Draft>(field: K, value: SetStateAction<Draft[K]>) => updateFor(record, field, value), [record, updateFor]);
	const writeDraft = useCallback((id: string, value: string) => updateFor(views.get(id), "text", value), [views, updateFor]);
	const setDraft = useCallback((value: SetStateAction<string>) => update("text", value), [update]);
	const setImages = useCallback((value: SetStateAction<Draft["images"]>) => update("images", value), [update]);
	const setBehavior = useCallback((value: SetStateAction<Draft["behavior"]>) => update("behavior", value), [update]);
	const draft = record?.draft ?? empty;
	return { draft: draft.text, images: draft.images, behavior: draft.behavior, setDraft, setImages, setBehavior, writeDraft };
}
